import {
  createEvent,
  deserializeSimulation,
  initializeSimulation,
  ProcessDefinition,
  ProcessHandler,
  registerProcess,
  runSimulation,
  scheduleEvent,
  serializeSimulation,
  StateData,
} from "../mod.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  const fooProcess: ProcessHandler = (sim, event, state) => {
    console.log(sim.currentTime);

    return { updated: event, state: state };
  };

  const foo: ProcessDefinition = {
    type: "foo",
    initial: "start",
    states: {
      "start": fooProcess,
    },
  };

  sim.registry = registerProcess(sim, foo);

  interface MachineData extends StateData {
    at: number;
    foo: string;
  }

  const startProcess: ProcessHandler<MachineData> = (sim, event, state) => {
    console.log(sim.currentTime, "machine start");

    const newData = { ...state.data };
    newData["foo"] = "foofoo";

    return {
      updated: { ...event },
      state: {
        ...state,
        step: "paused",
        data: { ...newData },
      },
      next: createEvent(sim, sim.currentTime + 10),
    };
  };

  const pausedProcess: ProcessHandler<MachineData> = (sim, event, state) => {
    console.log(sim.currentTime, "machine paused");
    console.log(state.data["foo"]);

    return {
      updated: { ...event },
      state: {
        ...state,
        step: "stop",
        data: { ...state.data },
      },
      next: createEvent(sim, sim.currentTime + 10),
    };
  };

  const stopProcess: ProcessHandler<MachineData> = (sim, event, state) => {
    console.log(sim.currentTime, "machine stopped");
    console.log("machine stopped");

    return {
      updated: { ...event },
      state: {
        ...state,
        step: "start",
        data: { ...state.data },
      },
    };
  };

  const machine: ProcessDefinition<MachineData> = {
    type: "machine",
    initial: "start",
    states: {
      "start": startProcess,
      "paused": pausedProcess,
      "stop": stopProcess,
    },
  };

  sim.registry = registerProcess(sim, machine);

  const e1 = createEvent(sim, 10, "foo");
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 20, "timeout", {
    at: 20,
    duration: 20,
    callback: "foo",
  });
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 30, "machine", {
    at: 30,
    foo: "bar",
  });
  sim.events = scheduleEvent(sim, e3);

  // TODO: Run until 30 and pause simulation
  const [stop, stats] = runSimulation(sim);
  // TODO:
  const stop2 = serializeSimulation(stop);
  const stop3 = deserializeSimulation(stop2);
  console.log(stop3);
  // TODO: Resume simulation from deserialized data
  const [_deserializedStop, _deserializedStats] = runSimulation(stop3);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
