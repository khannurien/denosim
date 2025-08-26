import {
  createEvent,
  Event,
  EventState,
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

if (import.meta.main) {
  const sim = initializeSimulation();

  interface FooData extends StateData {
    "store": string;
    "data": FooStoreData;
  }

  interface FooStoreData extends StateData {
    "foo": string;
  }

  const store = initializeStore<FooStoreData>(
    {},
  );

  sim.stores = registerStore(sim, store);

  const prod: ProcessDefinition<{
    start: [FooData, [FooData]];
    stop: [FooData, []];
  }> = {
    type: "prod",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] prod @ start`);

        const request = put(sim, event, state.data["store"], {
          ...state.data,
          data: { foo: "bar" },
        });

        // TODO:
        if (request.id !== event.id) {
          // It worked
        } else {
          // Delayed
        }

        const nextState = { ...state, step: "check" };
        const nextEvent = createEvent<FooData>(
          sim,
          {
            scheduledAt: sim.currentTime,
          },
        );

        return {
          updated: event,
          state: nextState,
          next: [{ ...nextEvent, status: EventState.Waiting }],
        };
      },
      stop(sim, event, state) {
        console.log(
          `[${sim.currentTime}] prod @ stop`,
        );

        return {
          updated: event,
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, prod);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "prod",
      data: {
        store: store.id,
      },
    },
  });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "cons",
      data: {
        store: store.id,
      },
    },
  });
  sim.events = scheduleEvent(sim, e2);

  const [states, stats] = await runSimulation(sim);
  const stop = states[states.length - 1];

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
