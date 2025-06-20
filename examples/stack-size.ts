import { ProcessDefinition, ProcessHandler } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  let FOO = 0;

  const startProcess: ProcessHandler = (sim, event, state) => {
    if (sim.currentTime < 10000000) {
      const newState = {
        ...state,
        step: "continue",
        data: { ...state.data },
      };
      const nextEvent = { ...event };

      return {
        updated: { ...event },
        state: {
          ...state,
          step: "start",
          data: { ...state.data },
        },
        next: createEvent(sim, sim.currentTime + 1, "timeout", {
          at: sim.currentTime + 1,
          duration: 1,
          callback: "foo",
        })
      };
    } else {
      return {
        updated: { ...event },
        state: {
          ...state,
          step: "start",
          data: { ...state.data },
        },
      };
    }
  };

  const foo: ProcessDefinition = {
    type: "foo",
    initial: "start",
    states: {
      "start": startProcess,
      "continue": continueProcess,
      "stop": emptyProcess,
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, 0, "foo");
  sim.events = scheduleEvent(sim, e1);

  const [stop, stats] = runSimulation(sim);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
