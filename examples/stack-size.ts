import {
  createEvent,
  initializeSimulation,
  ProcessDefinition,
  registerProcess,
  runSimulation,
  scheduleEvent,
  StateData,
} from "../mod.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  interface FooData extends StateData {
    "count": number;
    "stop": number;
  }

  const foo: ProcessDefinition<{
    start: [FooData, [FooData]];
    stop: [FooData, []];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] Got ${state.data["count"]}`);

        return {
          updated: event,
          state: {
            ...state,
            data: sim.currentTime < state.data["stop"]
              ? { ...state.data, count: state.data["count"] + 1 }
              : { ...state.data },
            step: sim.currentTime < state.data["stop"] ? "start" : "stop",
          },
          next: [
            createEvent(sim, {
              parent: event.id,
              scheduledAt: sim.currentTime < state.data["stop"]
                ? sim.currentTime + 1
                : sim.currentTime,
            }),
          ],
        };
      },
      stop(sim, event, state) {
        console.log(
          `[${sim.currentTime}] Process finished with ${state.data["count"]}`,
        );

        return {
          updated: event,
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "foo",
      data: {
        count: 0,
        stop: 10000,
      },
    },
  });
  sim.events = scheduleEvent(sim, e1);

  const [states, stats] = await runSimulation(sim, {});
  const stop = states[states.length - 1];

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
