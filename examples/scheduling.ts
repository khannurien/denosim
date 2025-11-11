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

/**
 * Expected output:
 *
 * [10] foo from main
 * [20] bar before timeout
 * [30] foo from main
 * [35] bar after timeout
 * [35] callback from bar before timeout
 * [37] foo from main
 * [40] callback from bar after timeout
 * [40] callback from the callback from bar after timeout
 * [50] foo from main
 * [60] baz before
 * [70] baz after
 * [70] foo from baz
 * Simulation ended at 70
 */

if (import.meta.main) {
  interface FooData extends StateData {
    from: string;
  }

  interface TimeoutData extends StateData {
    duration: number;
    startedAt: number;
  }

  const sim = initializeSimulation();

  const fooCb: ProcessDefinition<{
    none: [FooData, []];
  }> = {
    type: "foo",
    initial: "none",
    steps: {
      none(sim, _event, state) {
        console.log(`[${sim.currentTime}] foo from ${state.data["from"]}`);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, fooCb);

  const barCb: ProcessDefinition<{
    start: [TimeoutData, [TimeoutData]];
    wait: [TimeoutData, [TimeoutData]];
    stop: [TimeoutData, []];
  }> = {
    type: "bar",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] bar before timeout`);

        return {
          state: {
            ...state,
            step: "wait",
            data: {
              duration: 15,
              startedAt: sim.currentTime,
            },
          },
          next: [
            createEvent(sim, {
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: "bar",
                inheritStep: true, // Continue from parent's state
              },
            }),
          ],
        };
      },
      wait(sim, event, state) {
        const startedAt = state.data["startedAt"];
        const duration = state.data["duration"];
        const targetTime = startedAt + duration;

        if (sim.currentTime >= targetTime) {
          // Timeout completed
          console.log(`[${sim.currentTime}] bar after timeout`);
          return {
            state: {
              ...state,
              step: "stop",
            },
            next: [
              createEvent(sim, {
                scheduledAt: sim.currentTime,
                process: {
                  type: "step1",
                  data: {
                    duration: 5,
                    startedAt: sim.currentTime,
                  },
                },
              }),
            ],
          };
        } else {
          // Still waiting
          const nextEvent: Event<TimeoutData> = createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: targetTime, // Schedule exactly at completion time
              process: {
                type: "bar",
                inheritStep: true, // Continue from parent's state
              },
            },
          );

          return {
            state: { ...state, step: "wait" },
            next: [nextEvent],
          };
        }
      },
      stop(_sim, _event, state) {
        // Final completion
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, barCb);

  const step1Cb: ProcessDefinition<{
    start: [TimeoutData, [TimeoutData]];
    wait: [TimeoutData, [StateData | TimeoutData]];
    stop: [TimeoutData, []];
  }> = {
    type: "step1",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] callback from bar before timeout`);

        return {
          state: {
            ...state,
            step: "wait",
            data: {
              duration: 5,
              startedAt: sim.currentTime,
            },
          },
          next: [
            createEvent(sim, {
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: "step1",
                inheritStep: true, // Continue from parent's state
              },
            }),
          ],
        };
      },
      wait(sim, event, state) {
        const startedAt = state.data["startedAt"];
        const duration = state.data["duration"];
        const targetTime = startedAt + duration;

        if (sim.currentTime >= targetTime) {
          // Timeout completed
          console.log(`[${sim.currentTime}] callback from bar after timeout`);
          return {
            state: {
              ...state,
              step: "stop",
            },
            next: [
              createEvent(sim, {
                scheduledAt: sim.currentTime,
                process: {
                  type: "step2",
                },
              }),
            ],
          };
        } else {
          // Still waiting
          const nextEvent = createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: targetTime,
              process: {
                type: "step1",
                inheritStep: true, // Continue from parent's state
              },
            },
          );

          return {
            state: { ...state, step: "wait" },
            next: [nextEvent],
          };
        }
      },
      stop(_sim, _event, state) {
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, step1Cb);

  const step2Cb: ProcessDefinition<{
    none: [StateData, []];
  }> = {
    type: "step2",
    initial: "none",
    steps: {
      none(sim, _event, state) {
        console.log(
          `[${sim.currentTime}] callback from the callback from bar after timeout`,
        );
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, step2Cb);

  const bazCb: ProcessDefinition<{
    start: [TimeoutData, [TimeoutData]];
    wait: [TimeoutData, [StateData | TimeoutData]];
    stop: [TimeoutData, []];
  }> = {
    type: "baz",
    initial: "start",
    steps: {
      start(sim, event, state) {
        console.log(`[${sim.currentTime}] baz before`);

        return {
          state: {
            ...state,
            step: "wait",
            data: {
              duration: 10,
              startedAt: sim.currentTime,
            },
          },
          next: [createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: sim.currentTime,
              process: {
                type: "baz",
                inheritStep: true, // Continue from parent's state
              },
            },
          )],
        };
      },
      wait(sim, event, state) {
        const startedAt = state.data["startedAt"];
        const duration = state.data["duration"];
        const targetTime = startedAt + duration;

        if (sim.currentTime >= targetTime) {
          console.log(`[${sim.currentTime}] baz after`);
          return {
            state: {
              ...state,
              step: "stop",
            },
            next: [
              createEvent(
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
            ],
          };
        } else {
          const nextEvent: Event<TimeoutData> = createEvent(
            sim,
            {
              parent: event.id,
              scheduledAt: targetTime,
              process: {
                type: "baz",
                inheritStep: true, // Continue from parent's state
              },
            },
          );

          return {
            state: { ...state, step: "wait" },
            next: [nextEvent],
          };
        }
      },
      stop(_sim, _event, state) {
        return {
          state,
          next: [],
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

  const [states, stats] = await runSimulation(sim);
  const stop = states[states.length - 1];

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
