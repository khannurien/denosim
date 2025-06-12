import { deserializeSimulation, ProcessDefinition, ProcessHandler, registerProcess } from "../mod.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
  serializeSimulation,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  const fooProcess: ProcessHandler<void, void> = (sim, event, state) => {
    console.log(sim.currentTime);

    return { updated: event, state: state };
  }

  const foo: ProcessDefinition<void, void> = {
    type: "foo",
    initial: "start",
    states: {
      "start": fooProcess,
    }
  }

  sim.registry = registerProcess(sim, foo);

  interface TimeoutData<T = void> {
    at: number;
    duration: number;
    callback: string;
    item?: T;
  }

  const timeoutProcess: ProcessHandler<TimeoutData> = (sim, event, state) => {
    console.log("from process:", state);

    return {
      updated: { ...event },
      state: {
        ...state,
        step: "suspended",
        data: { ...state.data },
      },
      next: sim.currentTime === state.data["at"] + state.data["duration"] ? undefined : createEvent(
        sim,
        sim.currentTime + state.data["duration"],
        state.data["callback"],
        state.data["item"],
      )
    }
  }

  const timeout: ProcessDefinition<TimeoutData> = {
    type: "timeout",
    initial: "suspended",
    states: {
      "suspended": timeoutProcess,
    }
  }

  sim.registry = registerProcess(sim, timeout as ProcessDefinition<unknown, unknown>);

  const e1 = createEvent(sim, 10, "foo");
  sim.events = scheduleEvent(sim, e1);
  
  const e2 = createEvent(sim, 20, "timeout", { at: 20, duration: 20, callback: "foo" });
  sim.events = scheduleEvent(sim, e2);

  const [stop, stats] = runSimulation(sim);

  const stop2 = serializeSimulation(stop);
  const stop3 = deserializeSimulation(stop2);
  // console.log(stop3);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
