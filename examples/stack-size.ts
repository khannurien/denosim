import {
  createEvent,
  Event,
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
        console.log(
          `[${sim.currentTime}] Event id = ${event.id}; stop = ${
            state.data["stop"]
          }; got count = ${state.data["count"]}`,
        );

        const nextEvent: Event<FooData> = createEvent({
          parent: event.id,
          scheduledAt: sim.currentTime < state.data["stop"]
            ? sim.currentTime + 1
            : sim.currentTime,
          process: {
            type: "foo",
            inheritStep: true,
          },
        });

        return {
          state: {
            ...state,
            data: sim.currentTime < state.data["stop"]
              ? { ...state.data, count: state.data["count"] + 1 }
              : { ...state.data },
            step: sim.currentTime < state.data["stop"] ? "start" : "stop",
          },
          next: [nextEvent],
        };
      },
      stop(sim, _event, state) {
        console.log(
          `[${sim.currentTime}] Process finished with ${state.data["count"]}`,
        );

        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent({
    scheduledAt: 0,
    process: {
      type: "foo",
      data: {
        count: 0,
        stop: 3000,
      },
    },
  });
  sim.timeline = scheduleEvent(sim, e1);

  const [stop, stats] = await runSimulation(sim);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
