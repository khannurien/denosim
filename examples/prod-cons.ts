import {
  createEvent,
  EventState,
  get,
  initializeSimulation,
  initializeStore,
  ProcessDefinition,
  put,
  registerProcess,
  registerStore,
  runSimulation,
  scheduleEvent,
  StateData,
} from "../mod.ts";

/**
 * Expected output (non-blocking):
 *
 * [20] Cons -- trying to get [#1]...
 * [25] Prod -- put foobar in store
 * [25] Cons -- item: "foobar"
 * [25] Prod -- done [#1]...
 * [45] Prod -- put foobar in store
 * [45] Prod -- done [#2]...
 * [50] Cons -- trying to get [#2]...
 * [50] Cons -- item: "foobar"
 * [60] Cons -- trying to get [#3]...
 * [60] Prod -- put foobar in store
 * [60] Cons -- item: "foobar"
 * [60] Prod -- done [#3]...
 *
 * Expected output (blocking):
 * [20] Cons -- trying to get [#1]...
 * [25] Prod -- put foobar in store
 * [25] Cons -- item: "foobar"
 * [25] Prod -- done [#1]...
 * [45] Prod -- put foobar in store
 * [50] Cons -- trying to get [#2]...
 * [50] Prod -- done [#2]...
 * [50] Cons -- item: "foobar"
 * [60] Cons -- trying to get [#3]...
 * [60] Prod -- put foobar in store
 * [60] Cons -- item: "foobar"
 * [60] Prod -- done [#3]...
 */

if (import.meta.main) {
  const sim = initializeSimulation();

  interface StringData extends StateData {
    item: string;
  }

  // Create a non-blocking store with capacity 1 for the expected output
  const store = initializeStore<StringData>({
    capacity: 1,
    blocking: true, // Change to true for blocking behavior
  });

  sim.stores = registerStore(sim, store);

  let consCount = 0;
  let prodCount = 0;

  const prod: ProcessDefinition<{
    put: [StringData, [StringData] | []];
    done: [StringData, []];
  }> = {
    type: "prod",
    initial: "put",
    steps: {
      put(sim, event, state) {
        // Wakeup case: already completed put, just finish
        if (state.data.item) {
          console.log(`[${sim.currentTime}] Prod -- done [#${++prodCount}]...`);
          return {
            updated: {
              ...event,
              scheduledAt: sim.currentTime,
              status: EventState.Scheduled,
            },
            state: { ...state, step: "done" },
            next: [],
          };
        }

        // New put operation
        const item = "foobar";
        console.log(`[${sim.currentTime}] Prod -- put ${item} in store`);

        const request = put(sim, event, store.id, { item });

        if (
          request.id !== event.id || request.status === EventState.Scheduled
        ) {
          // Immediate success
          console.log(`[${sim.currentTime}] Prod -- done [#${++prodCount}]...`);
          return {
            updated: {
              ...event,
              scheduledAt: sim.currentTime,
              status: EventState.Scheduled,
            },
            state: { ...state, step: "done" },
            next: request.id !== event.id ? [request] : [],
          };
        }

        // Blocked - store the item and retry
        return {
          updated: {
            ...event,
            scheduledAt: sim.currentTime,
            status: EventState.Waiting,
          },
          state: { ...state, data: { item }, step: "put" },
          next: [],
        };
      },
      done(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  const cons: ProcessDefinition<{
    get: [StringData, [StringData] | []];
    done: [StringData, []];
  }> = {
    type: "cons",
    initial: "get",
    steps: {
      get(sim, event, state) {
        // Wakeup case: already have data
        if (event.process.data?.item) {
          const obtained = event.process.data as StringData;
          console.log(
            `[${sim.currentTime}] Cons -- item: ${
              JSON.stringify(obtained.item)
            }`,
          );
          return {
            updated: {
              ...event,
              scheduledAt: sim.currentTime,
              status: EventState.Scheduled,
            },
            state: { ...state, data: obtained, step: "done" },
            next: [],
          };
        }

        console.log(
          `[${sim.currentTime}] Cons -- trying to get [#${++consCount}]...`,
        );
        const request = get(sim, event, store.id);

        // Success cases
        if (
          (!store.blocking && request.status === EventState.Scheduled &&
            request.process.data) ||
          (request.id !== event.id && request.process.type === "prod")
        ) {
          const obtained = request.process.data as StringData;
          console.log(
            `[${sim.currentTime}] Cons -- item: ${
              JSON.stringify(obtained.item)
            }`,
          );

          return {
            updated: {
              ...event,
              scheduledAt: sim.currentTime,
              status: EventState.Scheduled,
            },
            state: { ...state, data: obtained, step: "done" },
            next: request.id !== event.id ? [request] : [],
          };
        }

        // Still waiting
        return {
          updated: {
            ...event,
            scheduledAt: sim.currentTime,
            status: EventState.Waiting,
          },
          state: { ...state, step: "get" },
          next: [],
        };
      },
      done(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  sim.registry = registerProcess(sim, prod);
  sim.registry = registerProcess(sim, cons);

  const e1 = createEvent(sim, {
    scheduledAt: 20,
    process: {
      type: "cons",
    },
  });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, {
    scheduledAt: 25,
    process: {
      type: "prod",
    },
  });
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, {
    scheduledAt: 45,
    process: {
      type: "prod",
    },
  });
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent(sim, {
    scheduledAt: 50,
    process: {
      type: "cons",
    },
  });
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent(sim, {
    scheduledAt: 60,
    process: {
      type: "prod",
    },
  });
  sim.events = scheduleEvent(sim, e5);

  const e6 = createEvent(sim, {
    scheduledAt: 60,
    process: {
      type: "cons",
    },
  });
  sim.events = scheduleEvent(sim, e6);

  const [states, stats] = await runSimulation(sim);
  const stop = states[states.length - 1];

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
