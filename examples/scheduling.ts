import {
  ProcessCall,
  ProcessCallData,
  ProcessDefinition,
  ProcessStep,
  StateData,
} from "../src/model.ts";
import {
  createEvent,
  deserializeSimulation,
  initializeSimulation,
  registerProcess,
  runSimulation,
  scheduleEvent,
  serializeSimulation,
} from "../src/simulation.ts";

/**
 * Expected output:
 *
 * [10] foo
 * [20] bar before timeout
 * [30] foo
 * [35] callback from bar before timeout
 * [35] bar after timeout
 * [37] foo
 * [40] callback from bar after timeout
 * [50] foo
 * [60] baz before
 * [70] foo
 * [70] baz after
 * Simulation ended at 50
 */

interface FooData extends ProcessCallData {
  data: {
    from: string;
  };
}

interface TimeoutData<T extends StateData = StateData>
  extends StateData {
  duration: number;
  process?: ProcessCall<T>;
}

if (import.meta.main) {
  const sim = initializeSimulation();

  const fooCb: ProcessDefinition = {
    type: "foo",
    initial: "none",
    states: {
      none(sim, event, state): ProcessStep<FooData> {
        console.log(`[${sim.currentTime}] foo from ${state.data["from"]}`);

        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  sim.registry = registerProcess(sim, fooCb);

  const barCb: ProcessDefinition<TimeoutData> = {
    type: "bar",
    initial: "start",
    states: {
      start(sim, event, state): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] bar before timeout`);

        return {
          updated: { ...event },
          state: { ...state, step: "wait" },
          next: createEvent(
            {
              sim,
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: event.process.type,
                data: {
                  duration: 15,
                  process: {
                    type: "step1",
                  },
                },
              },
            },
          ),
        };
      },
      wait(sim, event, state): ProcessStep<TimeoutData> {
        const parent = sim.events.find((e) => e.id === event.parent);
        const startedAt = parent?.scheduledAt ?? sim.currentTime;

        const nextStep = (sim.currentTime < startedAt + state.data["duration"])
          ? "wait"
          : "stop";

        const remaining = startedAt + state.data["duration"] - sim.currentTime;
        console.log(`remaining = ${remaining}`);

        return {
          updated: { ...event },
          state: { ...state, step: nextStep },
          next: nextStep == "wait"
            ? createEvent(
              {
                sim,
                parent: event.id,
                scheduledAt: sim.currentTime + remaining,
                process: {
                  type: event.process.type,
                  data: {
                    duration: 15,
                    process: {
                      type: "step1",
                    },
                  },
                },
              },
            )
            : undefined,
        };
      },
      stop(sim, event, state): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] bar after timeout`);

        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  sim.registry = registerProcess(sim, barCb);

  const step1Cb: ProcessDefinition = {
    type: "step1",
    initial: "none",
    states: {
      none(sim, event, state): ProcessStep {
        console.log(`[${sim.currentTime}] callback from bar before timeout`);

        return {
          updated: { ...event },
          state: { ...state },
          next: createEvent(
            {
              sim,
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: event.process.type,
                data: {
                  duration: 5,
                  process: {
                    type: "step2",
                  },
                },
              },
            },
          ),
        };
      },
    },
  };

  sim.registry = registerProcess(sim, step1Cb);

  const step2Cb: ProcessDefinition = {
    type: "step2",
    initial: "none",
    states: {
      none(sim, event, state): ProcessStep {
        console.log(`[${sim.currentTime}] callback from bar after timeout`);

        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  sim.registry = registerProcess(sim, step2Cb);

  const bazCb: ProcessDefinition = {
    type: "baz",
    initial: "start",
    states: {
      start(sim, event, state): ProcessStep {
        console.log(`[${sim.currentTime}] baz before`);

        return {
          updated: { ...event },
          state: {
            ...state,
            step: "stop",
          },
          next: createEvent(
            {
              sim,
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: event.process.type,
                data: {
                  at: sim.currentTime,
                  duration: 10,
                  process: {
                    type: "foo",
                  },
                },
              },
            },
          ),
        };
      },
      stop(sim, event, state): ProcessStep {
        console.log(`[${sim.currentTime}] baz after`);

        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  sim.registry = registerProcess(sim, bazCb);

  const e1 = createEvent({
    sim,
    scheduledAt: 10,
    process: { type: "foo", data: { "from": "main" } },
  });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent({ sim, scheduledAt: 20, process: { type: "bar" } });
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent({ sim, scheduledAt: 30, process: { type: "foo" } });
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent({ sim, scheduledAt: 37, process: { type: "foo" } });
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent({ sim, scheduledAt: 50, process: { type: "foo" } });
  sim.events = scheduleEvent(sim, e5);

  const e6 = createEvent({ sim, scheduledAt: 60, process: { type: "baz" } });
  sim.events = scheduleEvent(sim, e6);

  const [stop, stats] = runSimulation(sim);

  const stop2 = serializeSimulation(stop);
  const stop3 = deserializeSimulation(stop2);
  console.log(stop3);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
