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
  }

  const fooData: FooData = {
    count: 0,
  };

  const foo: ProcessDefinition<{
    start: [FooData, [FooData]];
    stop: [FooData, []];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] Got ${state.data["count"]++}`);

        return {
          updated: event,
          state: { ...state, step: sim.currentTime < 10000 ? "start" : "stop" },
          next: [
            createEvent(sim, {
              parent: event.id,
              scheduledAt: sim.currentTime + 1,
            }),
          ],
        };
      },
      stop(sim, event, state) {
        console.log(`[${sim.currentTime}] Got ${state.data["count"]}`);

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
    process: { type: "foo", data: fooData },
  });
  sim.events = scheduleEvent(sim, e1);

  const [states, stats] = runSimulation(sim);
  const stop = states[states.length - 1];

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
