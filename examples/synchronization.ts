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
    {
      blocking: true,
    },
  );

  sim.stores = registerStore(sim, store);

  const prod: ProcessDefinition<{
    start: [FooData, [FooData, FooData] | [FooData]];
    stop: [FooData, []];
  }> = {
    type: "prod",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(
          `[${sim.currentTime}] prod @ start -- ${event.id} -- ${event.parent}`,
        );
        console.log(
          `[${sim.currentTime}] prod @ start state = ${state.data.foo}`,
        );

        const { step, resume } = put(sim, event, store.id, {
          ...state.data,
        });

        console.log(
          `[${sim.currentTime}] prod received: step = ${step} | resume = ${resume}`,
        );

        if (step.status === EventState.Waiting) {
          // Delayed
          console.log(
            `[${sim.currentTime}] prod put request for "${state.data.foo}" blocked on store ${store.id}`,
          );
        } else {
          // Succeeded
          console.log(
            `[${sim.currentTime}] prod put "${state.data.foo}" in store ${store.id}`,
          );
        }

        return {
          state: { ...state, step: "stop" },
          next: resume ? [step, resume] : [step],
        };
      },
      stop(sim, event, state) {
        console.log(
          `[${sim.currentTime}] prod @ stop -- ${event.id} -- ${event.parent}`,
        );

        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, prod);

  const cons: ProcessDefinition<{
    start: [FooData, [FooData, FooData] | [FooData]];
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

        const { step, resume } = get(sim, event, store.id);

        console.log(
          `[${sim.currentTime}] cons received: step = ${step} | resume = ${resume}`,
        );

        if (step.status === EventState.Waiting) {
          // Delayed
          console.log(
            `[${sim.currentTime}] cons get request blocked on store ${store.id}`,
          );
        } else {
          // Succeeded
          console.log(
            `[${sim.currentTime}] cons got data from store ${store.id}`,
          );
        }

        return {
          state: {
            ...state,
            data: { ...step.process.data ?? state.data },
            step: "stop",
          },
          next: resume ? [step, resume] : [step],
        };
      },
      stop(sim, _event, state) {
        console.log(
          `[${sim.currentTime}] cons @ stop`,
        );
        console.log(
          `[${sim.currentTime}] cons @ stop state = ${state.data.foo}`,
        );

        return {
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
