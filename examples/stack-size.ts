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
    none: FooData;
  }> = {
    type: "foo",
    initial: "none",
    states: {
      none(sim, event, state) {
        console.log(`[${sim.currentTime}] Got ${state.data["count"]++}`);

        const nextEvent = sim.currentTime < 10000
          ? createEvent(sim, {
            scheduledAt: sim.currentTime + 1,
            process: { type: "foo", data: state.data },
          })
          : undefined;

        return {
          updated: event,
          state,
          next: nextEvent ? [nextEvent] : [],
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
