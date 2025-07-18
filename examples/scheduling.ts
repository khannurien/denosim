import { deserializeSimulation, ProcessState } from "../mod.ts";
import {
  Event,
  ProcessDefinition,
  ProcessHandler,
  ProcessStep,
  Simulation,
} from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  runSimulation,
  scheduleEvent,
  serializeSimulation,
  TimeoutData,
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
if (import.meta.main) {
  const sim = initializeSimulation();

  const fooCb: ProcessDefinition = {
    type: "foo",
    initial: "none",
    states: {
      none(sim, event, state): ProcessStep {
        console.log(`[${sim.currentTime}] foo`);

        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  sim.registry = registerProcess(sim, fooCb);

  const barCb: ProcessDefinition = {
    type: "bar",
    initial: "start",
    states: {
      start(sim, event, state): ProcessStep {
        console.log(`[${sim.currentTime}] bar before timeout`);

        return {
          updated: { ...event },
          state: { ...state, step: "wait" },
          next: createEvent(
            {
              sim,
              scheduledAt: sim.currentTime,
              callback: "timeout",
              data: {
                // at: sim.currentTime,
                duration: 15,
                callback: "step1",
              },
            },
          ),
        };
      },
      wait(sim, event, state: ProcessState<TimeoutData>): ProcessStep<TimeoutData> {
        const nextStep = (sim.currentTime < state.data["at"] + state.data["duration"])
          ? "wait"
          : "stop";

        const remaining = state.data["at"] + state.data["duration"] - sim.currentTime;

        // FIXME: Typing problem
        return {
          updated: { ...event },
          state: { ...state, step: nextStep },
          next: nextStep == "wait"
            ? createEvent(
              {
                sim,
                scheduledAt: sim.currentTime,
                callback: "timeout",
                data: {
                  // at: sim.currentTime,
                  duration: 15,
                  callback: "step1",
                },
              },
            )
            : undefined
        };
      },
      stop(sim, event, state): ProcessStep {
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
              scheduledAt: sim.currentTime,
              // callback: "timeout",
              data: {
                at: sim.currentTime,
                duration: 5,
                callback: "step2",
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
              scheduledAt: sim.currentTime,
              callback: "timeout",
              data: {
                at: sim.currentTime,
                duration: 10,
                callback: "foo",
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

  const e1 = createEvent({ sim, scheduledAt: 10, callback: "foo" });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent({ sim, scheduledAt: 20, callback: "bar" });
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent({ sim, scheduledAt: 30, callback: "foo" });
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent({ sim, scheduledAt: 37, callback: "foo" });
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent({ sim, scheduledAt: 50, callback: "foo" });
  sim.events = scheduleEvent(sim, e5);

  const e6 = createEvent({ sim, scheduledAt: 60, callback: "baz" });
  sim.events = scheduleEvent(sim, e6);

  const [stop, stats] = runSimulation(sim);

  const stop2 = serializeSimulation(stop);
  const stop3 = deserializeSimulation(stop2);
  console.log(stop3);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
