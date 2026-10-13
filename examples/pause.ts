import type { ProcessDefinition, Simulation, StateData } from "../mod.ts";
import {
  continueEvent,
  createEvent,
  deserializeSimulation,
  get,
  initializeSimulation,
  initializeStore,
  put,
  registerProcess,
  runSimulation,
  scheduleEvent,
  serializeSimulation,
} from "../mod.ts";

/**
 * A counter with two clerks, played in real time: `RATE` simulated minutes per second.
 * Any key pauses the run, wherever it is between two events, and writes its state to `FILE`; any key resumes it, `q` quits.
 * The file is enough to resume later, from another OS process: registries are not saved, the same code provides them again.
 *
 * deno run --allow-read=runs --allow-write=runs examples/pause.ts
 * deno run --allow-read=runs --allow-write=runs examples/pause.ts --resume
 *
 * Expected output, with a key pressed after two seconds, then `q`, then a second run with `--resume`:
 *
 * [0] customer 1 arrives
 * [0] customer 1 orders from Ada
 * [2] customer 2 arrives
 * [2] customer 2 orders from Bob
 * [4] customer 3 arrives
 * [4] customer 1 leaves
 * [4] customer 3 orders from Ada
 * [6] customer 4 arrives
 * [7] customer 3 leaves
 * [7] customer 4 orders from Ada
 * [8] customer 5 arrives
 * [8] customer 2 leaves
 * [8] customer 5 orders from Bob
 * Paused at 8.4, state written to runs/pause.json; any key resumes, q quits
 *
 * Resumed at 8.4
 * [10] customer 6 arrives
 * [12] customer 4 leaves
 * [12] customer 6 orders from Ada
 * [14] customer 6 leaves
 * [15] customer 5 leaves
 * Simulation ended at 15
 */

const RATE = 4;
const FILE = "runs/pause.json";

interface Clerk extends StateData {
  clerk: string;
}

interface Customer extends StateData {
  customer: number;
  minutes: number;
}

type Stores = { clerks: Clerk };

const customer: ProcessDefinition<
  {
    arrive: Customer;
    order: Customer;
    leave: Customer & Clerk;
  },
  Stores,
  { order: Clerk },
  "arrive"
> = {
  type: "customer",
  initial: "arrive",
  steps: {
    // First step, run by the event that starts the customer
    // Blocks until a clerk is free; the token arrives with the event that runs the next step
    arrive(sim, event, state) {
      console.log(
        `[${sim.currentTime}] customer ${state.data.customer} arrives`,
      );

      const { step, resume, finish } = get(sim, event, "clerks");

      return {
        state: { ...state, step: "order" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    // Run once a clerk is handed over: read from the event, and kept in the data to be put back
    // Timeout: the next step runs once the order is ready
    order(sim, event, state) {
      const { clerk } = event.process.data;
      console.log(
        `[${sim.currentTime}] customer ${state.data.customer} orders from ${clerk}`,
      );

      return {
        state: { ...state, step: "leave", data: { ...state.data, clerk } },
        next: [continueEvent(event, sim.currentTime + state.data.minutes)],
      };
    },
    // Run by the timeout: last step
    leave(sim, event, state) {
      console.log(
        `[${sim.currentTime}] customer ${state.data.customer} leaves`,
      );

      // `step` is not passed on, the customer ends here: sound as the store is never full
      const { resume, finish } = put(sim, event, "clerks", {
        clerk: state.data.clerk,
      });

      return { state, next: resume ?? [], finish };
    },
  },
};

const keys = Deno.stdin.readable.getReader();

/** `q`, Ctrl+C, or the end of the input */
function quits(key: ReadableStreamReadResult<Uint8Array>): boolean {
  return key.done || key.value[0] === 113 || key.value[0] === 3;
}

/**
 * Plays `sim` until no event is left, or until a key is pressed.
 * Calls itself to resume: once per pause.
 */
async function play(sim: Simulation<Stores>): Promise<void> {
  // Pause asked from outside the run: the signal stops it, and its clock, even during the wait before an event
  const pause = new AbortController();
  const pressed = keys.read().then((key) => {
    if (!key.done) pause.abort();
    return key;
  });

  const { result, next } = await runSimulation(sim, {
    rate: RATE,
    signal: pause.signal,
  });

  // No event left
  if (!next) {
    console.log(`Simulation ended at ${result.currentTime}`);
    return;
  }

  await Deno.mkdir("runs", { recursive: true });
  await Deno.writeTextFile(FILE, serializeSimulation(result));
  console.log(
    `Paused at ${
      result.currentTime.toFixed(1)
    }, state written to ${FILE}; any key resumes, q quits`,
  );

  if (quits(await pressed) || quits(await keys.read())) return;

  console.log(`Resumed at ${result.currentTime.toFixed(1)}`);
  await play(result);
}

if (import.meta.main) {
  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: { clerks: initializeStore({ capacity: 2 }) },
  };

  sim.processes = registerProcess(sim, customer);

  // Key presses are read one by one, without waiting for a line
  if (Deno.stdin.isTerminal()) Deno.stdin.setRaw(true);

  if (Deno.args.includes("--resume")) {
    // The state comes from the file, the registries from `sim`
    const paused = deserializeSimulation<Stores>(
      await Deno.readTextFile(FILE),
      sim,
    );

    console.log(`Resumed at ${paused.currentTime.toFixed(1)}`);
    await play(paused);
  } else {
    for (const clerk of ["Ada", "Bob"]) {
      put(sim, createEvent({ scheduledAt: 0 }), "clerks", { clerk });
    }

    const minutes = [4, 6, 3, 5, 7, 2];
    for (const [i, duration] of minutes.entries()) {
      sim.timeline = scheduleEvent(
        sim,
        createEvent({
          scheduledAt: 2 * i,
          process: {
            type: customer,
            data: { customer: i + 1, minutes: duration },
          },
        }),
      );
    }

    await play(sim);
  }

  if (Deno.stdin.isTerminal()) Deno.stdin.setRaw(false);
  await keys.cancel();
}
