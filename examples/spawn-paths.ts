import { Event, ProcessDefinition, StateData } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

interface DriverData extends StateData {
  shared: number;
  tag?: string;
}

interface WorkerData extends StateData {
  own: string;
  shared?: number;
}

const observations: string[] = [];

const driver: ProcessDefinition<{
  start: DriverData;
  done: DriverData;
}> = {
  type: "driver",
  initial: "start",
  steps: {
    start(sim, event, state) {
      observations.push(
        `[t=${sim.currentTime}] driver:start shared=${state.data.shared}`,
      );
      const nextShared = 42;

      // 1) CONTINUATION (fork-like): same process type + inheritStep=true
      const continuation: Event<DriverData> = createEvent({
        parent: event.id,
        scheduledAt: 1,
        process: {
          type: "driver",
          inheritStep: true,
          data: { shared: nextShared, tag: "continued" },
        },
      });

      // 2) NEW PROCESS WITH PARENT DATA (exec-like): parent linked, fresh initial step
      const inheritedSpawn: Event<WorkerData> = createEvent({
        parent: event.id,
        scheduledAt: 2,
        process: {
          type: "worker",
          data: { own: "exec-like" },
        },
      });

      // 3) BRAND NEW PROCESS (execve-like): no parent, only explicit input data
      const freshSpawn: Event<WorkerData> = createEvent({
        scheduledAt: 3,
        process: {
          type: "worker",
          data: { own: "execve-like" },
        },
      });

      return {
        state: {
          ...state,
          step: "done",
          data: { ...state.data, shared: nextShared },
        },
        next: [continuation, inheritedSpawn, freshSpawn],
      };
    },
    done(sim, _event, state) {
      observations.push(
        `[t=${sim.currentTime}] driver:done shared=${state.data.shared} tag=${state.data.tag}`,
      );
      return { state, next: [] };
    },
  },
};

const worker: ProcessDefinition<{
  start: WorkerData;
}> = {
  type: "worker",
  initial: "start",
  steps: {
    start(sim, _event, state) {
      observations.push(
        `[t=${sim.currentTime}] worker:${state.data.own} shared=${state.data.shared}`,
      );
      return { state, next: [] };
    },
  },
};

if (import.meta.main) {
  const sim = initializeSimulation();
  sim.registry = registerProcess(sim, driver);
  sim.registry = registerProcess(sim, worker);

  const root = createEvent({
    scheduledAt: 0,
    process: {
      type: "driver",
      data: { shared: 7 },
    },
  });
  sim.timeline = scheduleEvent(sim, root);

  await runSimulation(sim);

  // Expected:
  // - continuation keeps driver progress and sees shared=42
  // - exec-like worker inherits parent shared=42
  // - execve-like worker has no inherited shared
  for (const line of observations) {
    console.log(line);
  }
}
