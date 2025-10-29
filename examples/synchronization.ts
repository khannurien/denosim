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

if (import.meta.main) {
  const sim = initializeSimulation();

  interface FooData extends StateData {
    "foo": string;
  }

  const store = initializeStore<FooData>(
    {},
  );

  sim.stores = registerStore(sim, store);

  const prod: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "prod",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] prod @ start`);
        console.log(
          `[${sim.currentTime}] prod @ start state = ${state.data.foo}`,
        );

        // If there is a pending get request, it will be popped from the store and returned by `put`.
        // If there is none, `put` will:
        // - store the event as a new put request in the store's queue;
        // - return the event updated with stored data.
        const request = put(sim, event, store.id, {
          ...state.data,
        });

        if (request.id !== event.id) {
          // It worked
          console.log(
            `[${sim.currentTime}] prod put "${state.data.foo}" in store ${store.id}`,
          );
        } else {
          // Delayed
          console.log(
            `[${sim.currentTime}] prod put request for "${state.data.foo}" blocked on store ${store.id}`,
          );
        }

        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };

        return {
          updated: nextEvent,
          state: { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
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

  const cons: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "cons",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] cons @ start`);
        console.log(
          `[${sim.currentTime}] cons @ start state = ${state.data.foo}`,
        );

        const request = get(sim, event, store.id);

        if (request.id !== event.id) {
          // It worked
          const obtained = { ...request.process.data };
          console.log(
            `[${sim.currentTime}] cons get "${obtained.foo}" from store ${store.id}`,
          );
        } else {
          // Delayed
          console.log(
            `[${sim.currentTime}] cons get request blocked on store ${store.id}`,
          );
        }

        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };

        return {
          updated: nextEvent,
          state: request.id !== event.id
            ? {
              ...state,
              data: request.process.data
                ? { ...request.process.data }
                : state.data,
              step: "stop",
            }
            : { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(sim, event, state) {
        console.log(
          `[${sim.currentTime}] cons @ stop`,
        );
        console.log(
          `[${sim.currentTime}] cons @ stop state = ${state.data.foo}`,
        );

        return {
          updated: event,
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, cons);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "prod",
      data: {
        foo: "bar",
      },
    },
  });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, {
    scheduledAt: 1,
    process: {
      type: "cons",
    },
  });
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, {
    scheduledAt: 5,
    process: {
      type: "cons",
    },
  });
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent(sim, {
    scheduledAt: 10,
    process: {
      type: "prod",
      data: {
        "foo": "snafu",
      },
    },
  });
  sim.events = scheduleEvent(sim, e4);

  const [states, stats] = await runSimulation(sim);
  const stop = states[states.length - 1];

  console.log(stop.events);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
