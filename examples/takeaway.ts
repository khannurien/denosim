import type { ProcessDefinition, Simulation, StateData } from "../mod.ts";
import {
  continueEvent,
  createEvent,
  get,
  initializeSimulation,
  initializeStore,
  put,
  registerProcess,
  registerStore,
  runSimulation,
  scheduleEvent,
} from "../mod.ts";

/**
 * A takeaway with two cooks: customers order, then wait for their own meal.
 * Meals do not come out in the order they were asked for: on a shared counter, the first customer waiting would leave with the first meal out.
 * Each customer opens a pick-up slot instead, a store registered during the run, and the order says which slot its meal goes to.
 * Nobody knows up front which slots there will be: the simulation declares them by the shape of their ID.
 *
 * deno run examples/takeaway.ts
 *
 * Expected output:
 *
 * [0] Ada orders stew
 * [0] Sam cooks stew
 * [1] Bob orders salad
 * [1] Kim cooks salad
 * [2] Cleo orders soup
 * [3] Bob leaves with salad, cooked by Kim
 * [3] Kim cooks soup
 * [6] Cleo leaves with soup, cooked by Kim
 * [8] Ada leaves with stew, cooked by Sam
 * Simulation ended at 8
 * Stores at the start: orders
 * Stores at the end: orders, slot-Ada, slot-Bob, slot-Cleo
 */

/** The ID of a pick-up slot: one store per customer */
type Slot = `slot-${string}`;

interface Order extends StateData {
  dish: string;
  minutes: number;
  slot: Slot;
}

interface Meal extends StateData {
  dish: string;
  cook: string;
}

interface Customer extends StateData {
  name: string;
  dish: string;
  minutes: number;
}

/** A customer who ordered keeps the ID of the slot to wait at */
interface Served extends Customer {
  slot: Slot;
}

interface Cook extends StateData {
  cook: string;
}

interface Cooking extends Cook {
  order: Order;
}

/** `orders` is there from the start; slots are registered as customers come in */
type Stores = { orders: Order } & { [slot: Slot]: Meal };

const customer: ProcessDefinition<
  {
    order: Customer;
    wait: Served;
    leave: Served;
  },
  Stores,
  { leave: Meal },
  "order"
> = {
  type: "customer",
  initial: "order",
  steps: {
    // First step, run by the event that starts the customer
    // Opens a slot, and sends an order that names it
    order(sim, event, state) {
      const { name, dish, minutes } = state.data;
      console.log(`[${sim.currentTime}] ${name} orders ${dish}`);

      // A store registered by a handler: assigned to `sim.stores`, as before a run
      // The ID is the customer's own: a store registered under an ID already taken would replace the one there
      // No capacity: a meal is handed over to a customer who waits, it is never left in the slot
      const slot: Slot = `slot-${name}`;
      sim.stores = registerStore(sim, slot, initializeStore({}));

      // Goes to a cook blocked on `orders`, if any (`resume` is that cook), or stays there until one is free
      // Either way `step` carries the customer on, to the next step
      const { step, resume, finish } = put(sim, event, "orders", {
        dish,
        minutes,
        slot,
      });

      return {
        state: { ...state, step: "wait", data: { ...state.data, slot } },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    // Run right after the order is sent, at the same time
    // Blocks on the slot: the meal arrives with the event that runs the next step
    wait(sim, event, state) {
      const { step, resume, finish } = get(sim, event, state.data.slot);

      return {
        state: { ...state, step: "leave" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    // Run once a cook puts the meal in the slot: the meal is read from the event
    // Nothing is returned in `next`, the customer ends here
    leave(sim, event, state) {
      const { dish, cook } = event.process.data;
      console.log(
        `[${sim.currentTime}] ${state.data.name} leaves with ${dish}, cooked by ${cook}`,
      );

      return { state, next: [] };
    },
  },
};

const cook: ProcessDefinition<
  {
    idle: Cook;
    cook: Cook;
    serve: Cooking;
  },
  Stores,
  { cook: Order },
  "idle"
> = {
  type: "cook",
  initial: "idle",
  steps: {
    // First step, run by the event that starts the cook, then after each meal: a cook never ends
    // Blocks until there is an order, first come, first served; it arrives with the event that runs the next step
    idle(sim, event, state) {
      const { step, resume, finish } = get(sim, event, "orders");

      return {
        state: { ...state, step: "cook" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    // Run once an order is handed over: read from the event, and kept in the data for the next step
    // Timeout: the next step runs once the dish is ready
    cook(sim, event, state) {
      const order = event.process.data;
      console.log(
        `[${sim.currentTime}] ${state.data.cook} cooks ${order.dish}`,
      );

      return {
        state: { ...state, step: "serve", data: { ...state.data, order } },
        next: [continueEvent(event, sim.currentTime + order.minutes)],
      };
    },
    // Run by the timeout
    // Puts the meal in the slot the order names: a store the cook knows by an ID received during the run
    serve(sim, event, state) {
      const { cook, order } = state.data;

      // The customer is blocked there: `resume` carries them on with the meal, `step` carries the cook on, back to the first step
      const { step, resume, finish } = put(sim, event, order.slot, {
        dish: order.dish,
        cook,
      });

      return {
        state: { ...state, step: "idle", data: { cook } },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
  },
};

if (import.meta.main) {
  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: { orders: initializeStore({ capacity: Number.MAX_SAFE_INTEGER }) },
  };

  sim.processes = registerProcess(sim, customer);
  sim.processes = registerProcess(sim, cook);

  for (const name of ["Sam", "Kim"]) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({
        scheduledAt: 0,
        process: { type: cook, data: { cook: name } },
      }),
    );
  }

  const customers = [
    { at: 0, name: "Ada", dish: "stew", minutes: 8 },
    { at: 1, name: "Bob", dish: "salad", minutes: 2 },
    { at: 2, name: "Cleo", dish: "soup", minutes: 3 },
  ];
  for (const { at, ...data } of customers) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: at, process: { type: customer, data: data } }),
    );
  }

  const { result } = await runSimulation(sim);

  console.log(`Simulation ended at ${result.currentTime}`);

  // The run leaves `sim` untouched: the slots are in the state it returns
  console.log(`Stores at the start: ${Object.keys(sim.stores).join(", ")}`);
  console.log(`Stores at the end: ${Object.keys(result.stores).join(", ")}`);
}
