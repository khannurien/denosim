import {
  Event,
  ProcessDefinition,
  ProcessState,
  ProcessStep,
  StateData,
} from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

/**
 * Expected output:
 *
 * [10] foo from main
 * [20] bar before timeout
 * [30] foo from main
 * [35] callback from bar before timeout
 * [35] bar after timeout
 * [37] foo from main
 * [40] callback from bar after timeout
 * [50] foo from main
 * [60] baz before
 * [70] foo from baz
 * [70] baz after
 * Simulation ended at 70
 */

interface FooData extends StateData {
  from: string;
}

interface TimeoutData extends StateData {
  duration: number;
}

if (import.meta.main) {
  const sim = initializeSimulation();

  const fooCb: ProcessDefinition<{
    none: FooData;
  }> = {
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

  const barCb: ProcessDefinition<{
    start: TimeoutData;
    wait: TimeoutData;
    stop: TimeoutData;
  }> = {
    type: "bar",
    initial: "start",
    states: {
      start(sim, event, state): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] bar before timeout`);

        return {
          updated: { ...event },
          state: {
            ...state,
            step: "wait",
            data: {
              duration: 15,
            },
          },
          next: createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: event.process.type,
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

        return {
          updated: { ...event },
          state: { ...state, step: nextStep },
          next: nextStep == "stop"
            ? createEvent(
              sim,
              {
                parent: event.id,
                scheduledAt: sim.currentTime,
                process: {
                  type: event.process.type,
                },
              },
            )
            : createEvent(
              sim,
              {
                parent: event.id,
                scheduledAt: sim.currentTime + remaining,
                process: {
                  type: event.process.type,
                },
              },
            ),
        };
      },
      stop(sim, event, state): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] bar after timeout`);

        return {
          updated: { ...event },
          state: { ...state },
          next: createEvent(
            sim,
            {
              scheduledAt: sim.currentTime,
              process: {
                type: "step1",
              },
            },
          ),
        };
      },
    },
  };

  sim.registry = registerProcess(sim, barCb);

  const step1Cb: ProcessDefinition<{
    start: TimeoutData;
    wait: TimeoutData;
    stop: TimeoutData;
  }> = {
    type: "step1",
    initial: "start",
    states: {
      start(sim, event, state): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] callback from bar before timeout`);

        return {
          updated: { ...event },
          state: {
            ...state,
            step: "wait",
            data: {
              duration: 5,
            },
          },
          next: createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: event.process.type,
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

        return {
          updated: { ...event },
          state: { ...state, step: nextStep },
          next: nextStep == "stop"
            ? createEvent(
              sim,
              {
                parent: event.id,
                scheduledAt: sim.currentTime,
                process: {
                  type: event.process.type,
                },
              },
            )
            : createEvent(
              sim,
              {
                parent: event.id,
                scheduledAt: sim.currentTime + remaining,
                process: {
                  type: event.process.type,
                },
              },
            ),
        };
      },
      stop(sim, event, state): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] callback from bar after timeout`);

        return {
          updated: { ...event },
          state: { ...state },
          next: createEvent(
            sim,
            {
              scheduledAt: sim.currentTime,
              process: {
                type: "step2",
              },
            },
          ),
        };
      },
    },
  };

  sim.registry = registerProcess(sim, step1Cb);

  const step2Cb: ProcessDefinition<{
    none: StateData;
  }> = {
    type: "step2",
    initial: "none",
    states: {
      none(sim, event, state): ProcessStep {
        console.log(
          `[${sim.currentTime}] callback from the callback from bar after timeout`,
        );

        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  sim.registry = registerProcess(sim, step2Cb);

  const bazCb: ProcessDefinition<{
    start: TimeoutData;
    wait: TimeoutData;
    stop: FooData;
  }> = {
    type: "baz",
    initial: "start",
    states: {
      start(
        sim,
        event: Event<TimeoutData>,
        state: ProcessState<TimeoutData>,
      ): ProcessStep<TimeoutData> {
        console.log(`[${sim.currentTime}] baz before`);

        return {
          updated: { ...event },
          state: {
            ...state,
            step: "wait",
            data: {
              duration: 10,
            },
          },
          next: createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: event.process.type,
              },
            },
          ),
        };
      },
      wait(
        sim,
        event: Event<TimeoutData>,
        state: ProcessState<TimeoutData>,
      ): ProcessStep<TimeoutData> {
        const parent = sim.events.find((e) => e.id === event.parent);
        const startedAt = parent?.scheduledAt ?? sim.currentTime;

        const nextStep = (sim.currentTime < startedAt + state.data["duration"])
          ? "wait"
          : "stop";

        const remaining = startedAt + state.data["duration"] - sim.currentTime;

        return {
          updated: { ...event },
          state: { ...state, step: nextStep },
          next: nextStep == "stop"
            ? createEvent(
              sim,
              {
                parent: event.id,
                scheduledAt: sim.currentTime,
                process: {
                  type: event.process.type,
                },
              },
            )
            : createEvent(
              sim,
              {
                parent: event.id,
                scheduledAt: sim.currentTime + remaining,
                process: {
                  type: event.process.type,
                },
              },
            ),
        };
      },
      stop(
        sim,
        event: Event<FooData>,
        state: ProcessState<FooData>,
      ): ProcessStep<FooData> {
        console.log(`[${sim.currentTime}] baz after`);

        return {
          updated: { ...event },
          state: { ...state },
          next: createEvent(
            sim,
            {
              scheduledAt: sim.currentTime,
              process: {
                type: "foo",
                data: {
                  from: "baz",
                },
              },
            },
          ),
        };
      },
    },
  };

  sim.registry = registerProcess(sim, bazCb);

  const e1 = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "foo", data: { "from": "main" } },
  });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, { scheduledAt: 20, process: { type: "bar" } });
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, {
    scheduledAt: 30,
    process: { type: "foo", data: { "from": "main" } },
  });
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent(sim, {
    scheduledAt: 37,
    process: { type: "foo", data: { "from": "main" } },
  });
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent(sim, {
    scheduledAt: 50,
    process: { type: "foo", data: { "from": "main" } },
  });
  sim.events = scheduleEvent(sim, e5);

  const e6 = createEvent(sim, { scheduledAt: 60, process: { type: "baz" } });
  sim.events = scheduleEvent(sim, e6);

  const [stop, stats] = runSimulation(sim);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
