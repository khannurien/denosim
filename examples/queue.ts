import type { ProcessDefinition, Simulation, StateData } from "../mod.ts";
import {
  continueEvent,
  createEvent,
  get,
  initializeSimulation,
  initializeStore,
  put,
  registerProcess,
  runSimulation,
  scheduleEvent,
} from "../mod.ts";

/**
 * A coffee shop with one barista.
 * The barista is a token in a store: a customer takes it to order, and puts it back when leaving.
 * A customer who finds the store empty waits there, first come, first served.
 *
 * deno run examples/queue.ts
 *
 * Expected output:
 *
 * [0] Ada arrives
 * [0] Ada orders from Sam
 * [1] Bob arrives
 * [2] Cleo arrives
 * [3] Ada leaves
 * [3] Bob orders from Sam
 * [5] Bob leaves
 * [5] Cleo orders from Sam
 * [9] Cleo leaves
 * Simulation ended at 9
 */

interface Barista extends StateData {
  barista: string;
}

interface Customer extends StateData {
  name: string;
  minutes: number;
}

type Stores = { counter: Barista };

const customer: ProcessDefinition<
  {
    arrive: Customer;
    order: Customer;
    leave: Customer & Barista;
  },
  Stores,
  { order: Barista },
  "arrive"
> = {
  type: "customer",
  initial: "arrive",
  steps: {
    arrive(sim, event, state) {
      console.log(`[${sim.currentTime}] ${state.data.name} arrives`);

      // Blocks until the barista is free; the token arrives with the event that runs the next step
      const { step, resume, finish } = get(sim, event, "counter");

      return {
        state: { ...state, step: "order" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    order(sim, event, state) {
      const { barista } = event.process.data;
      console.log(
        `[${sim.currentTime}] ${state.data.name} orders from ${barista}`,
      );

      // Timeout: the next step runs once the order is ready
      return {
        state: { ...state, step: "leave", data: { ...state.data, barista } },
        next: [continueEvent(event, sim.currentTime + state.data.minutes)],
      };
    },
    leave(sim, event, state) {
      console.log(`[${sim.currentTime}] ${state.data.name} leaves`);

      // Hands the barista to the next customer in line, if any
      // `step` is not passed on, the customer ends here: sound as the counter is never full
      const { resume, finish } = put(sim, event, "counter", {
        barista: state.data.barista,
      });

      return { state, next: resume ?? [], finish };
    },
  },
};

if (import.meta.main) {
  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: { counter: initializeStore({ capacity: 1 }) },
  };
  put(sim, createEvent({ scheduledAt: 0 }), "counter", { barista: "Sam" });

  sim.processes = registerProcess(sim, customer);

  const customers = [
    { at: 0, name: "Ada", minutes: 3 },
    { at: 1, name: "Bob", minutes: 2 },
    { at: 2, name: "Cleo", minutes: 4 },
  ];
  for (const { at, ...data } of customers) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: at, process: { type: customer, data: data } }),
    );
  }

  const { result } = await runSimulation(sim);

  console.log(`Simulation ended at ${result.currentTime}`);
}
