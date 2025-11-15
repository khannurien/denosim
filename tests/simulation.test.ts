import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createEvent,
  Event,
  EventState,
  initializeSimulation,
  ProcessDefinition,
  registerProcess,
  runSimulation,
  scheduleEvent,
  StateData,
} from "../mod.ts";

Deno.test("basic event scheduling", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  assertEquals(sim.events.length, 0);

  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 1);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events.length, 1);
  assertEquals(stop.events[0].finishedAt, 10);
  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("zero-duration events", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: sim.currentTime });
  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events[0].finishedAt, 0);
});

Deno.test("basic out of order scheduling", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  const e2 = createEvent(sim, { scheduledAt: 5 });
  const e3 = createEvent(sim, { scheduledAt: 15 });
  assertEquals(sim.events.length, 0);

  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 3);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events.length, 3);
  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("basic event ordering", async () => {
  const sim = initializeSimulation();

  const processedOrder: number[] = [];

  const foo: ProcessDefinition<{
    start: [StateData, []];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(_sim, event, state) {
        processedOrder.push(event.scheduledAt);

        return {
          state: state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: 10, process: { type: "foo" } });
  const e2 = createEvent(sim, { scheduledAt: 0, process: { type: "foo" } });
  const e3 = createEvent(sim, { scheduledAt: 15, process: { type: "foo" } });
  const e4 = createEvent(sim, { scheduledAt: 5, process: { type: "foo" } });
  const e5 = createEvent(sim, { scheduledAt: 2, process: { type: "foo" } });
  const e6 = createEvent(sim, { scheduledAt: 50, process: { type: "foo" } });

  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e4);
  sim.events = scheduleEvent(sim, e5);
  sim.events = scheduleEvent(sim, e6);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events.length, 6);
  assertEquals(processedOrder, [0, 2, 5, 10, 15, 50]);
  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("scheduling events in the past", () => {
  const sim = initializeSimulation();

  const foo: ProcessDefinition<{
    start: [StateData, [StateData]];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, _event, state) {
        const past = createEvent(sim, { scheduledAt: sim.currentTime - 1 });

        return {
          state: state,
          next: [past],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: -1 });
  const e2 = createEvent(sim, { scheduledAt: 10, process: { type: "foo" } });

  assertThrows(() => {
    sim.events = scheduleEvent(sim, e1);
  });
  sim.events = scheduleEvent(sim, e2);

  assertRejects(async () => {
    const [_states, _stats] = await runSimulation(sim);
  });
});

Deno.test("event process scheduling", async () => {
  const sim = initializeSimulation();

  const results: Record<number, Event> = {};

  const foo: ProcessDefinition<{
    start: [StateData, []];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, event, state) {
        results[sim.currentTime] = event;

        return {
          state: state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: 10, process: { type: "foo" } });
  const e2 = createEvent(sim, { scheduledAt: 20, process: { type: "foo" } });
  const e3 = createEvent(sim, { scheduledAt: 30, process: { type: "foo" } });
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  assertEquals(sim.events.length, 3);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(results[10].id, e1.id);
  assertEquals(results[20].id, e2.id);
  assertEquals(results[30].id, e3.id);

  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("simulation until time condition", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  const e2 = createEvent(sim, { scheduledAt: 20 });
  const e3 = createEvent(sim, { scheduledAt: 30 });
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);

  const [states, stats] = await runSimulation(sim, { untilTime: 20 });

  assertEquals(stats.end, 20);

  assert(states.length > 0);
  const stop = states[states.length - 1];
  assertEquals(
    stop.events.find((event) => event.id === e1.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e2.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e3.id)?.status,
    EventState.Scheduled,
  );
});

Deno.test("simulation until event condition", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  const e2 = createEvent(sim, { scheduledAt: 20 });
  const e3 = createEvent(sim, { scheduledAt: 30 });
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);

  const [states, stats] = await runSimulation(sim, { untilEvent: e2 });

  assertEquals(stats.end, 20);

  assert(states.length > 0);
  const stop = states[states.length - 1];
  assertEquals(
    stop.events.find((event) => event.id === e1.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e2.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e3.id)?.status,
    EventState.Scheduled,
  );
});

Deno.test("events with same time process by priority order (lower number = higher priority)", async () => {
  const sim = initializeSimulation();
  const executionOrder: string[] = [];

  const testProcess: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "test",
    initial: "log",
    steps: {
      log(_sim, _event, state) {
        executionOrder.push(state.data.name as string);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, testProcess);

  // Create events at same time with different priorities
  const lowPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 10, // Higher number = lower priority (processed later)
    process: { type: "test", data: { name: "low" } },
  });

  const mediumPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 5, // Medium priority
    process: { type: "test", data: { name: "medium" } },
  });

  const highPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 1, // Lower number = higher priority (processed first)
    process: { type: "test", data: { name: "high" } },
  });

  const defaultPriority = createEvent(sim, {
    scheduledAt: 10,
    // No priority specified = default 0 = highest priority
    process: { type: "test", data: { name: "default" } },
  });

  sim.events = scheduleEvent(sim, lowPriority);
  sim.events = scheduleEvent(sim, mediumPriority);
  sim.events = scheduleEvent(sim, highPriority);
  sim.events = scheduleEvent(sim, defaultPriority);

  await runSimulation(sim);

  // Should process in priority order: lowest number first (highest priority)
  assertEquals(executionOrder, ["default", "high", "medium", "low"]);
});

Deno.test("priority only affects ordering at same time", async () => {
  const sim = initializeSimulation();
  const executionOrder: string[] = [];

  const testProcess: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "test",
    initial: "log",
    steps: {
      log(sim, _event, state) {
        executionOrder.push(`${state.data.name}-${sim.currentTime}`);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, testProcess);

  // Mix of times and priorities - time should dominate
  const earlyLowPriority = createEvent(sim, {
    scheduledAt: 5,
    priority: 10, // Low priority but early time
    process: { type: "test", data: { name: "earlyLow" } },
  });

  const lateHighPriority = createEvent(sim, {
    scheduledAt: 15,
    priority: 1, // High priority but late time
    process: { type: "test", data: { name: "lateHigh" } },
  });

  const mediumDefault = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "test", data: { name: "medium" } },
  });

  sim.events = scheduleEvent(sim, earlyLowPriority);
  sim.events = scheduleEvent(sim, lateHighPriority);
  sim.events = scheduleEvent(sim, mediumDefault);

  await runSimulation(sim);

  // Time ordering should dominate over priority
  assertEquals(executionOrder, ["earlyLow-5", "medium-10", "lateHigh-15"]);
});

Deno.test("default priority is 0 (highest priority)", async () => {
  const sim = initializeSimulation();
  const executionOrder: string[] = [];

  const testProcess: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "test",
    initial: "log",
    steps: {
      log(_sim, _event, state) {
        executionOrder.push(state.data.priority as string);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, testProcess);

  const withPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 1, // Lower priority than default 0
    process: { type: "test", data: { priority: "explicit" } },
  });

  const withoutPriority = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "test", data: { priority: "default" } },
  });

  sim.events = scheduleEvent(sim, withPriority);
  sim.events = scheduleEvent(sim, withoutPriority);

  await runSimulation(sim);

  // Default 0 should process before explicit 1
  assertEquals(executionOrder, ["default", "explicit"]);
});

Deno.test("negative priorities work correctly (very high priority)", async () => {
  const sim = initializeSimulation();
  const executionOrder: string[] = [];

  const testProcess: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "test",
    initial: "log",
    steps: {
      log(_sim, _event, state) {
        executionOrder.push(state.data.name as string);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, testProcess);

  const veryHigh = createEvent(sim, {
    scheduledAt: 10,
    priority: -10, // Very high priority (lowest number)
    process: { type: "test", data: { name: "veryHigh" } },
  });

  const high = createEvent(sim, {
    scheduledAt: 10,
    priority: -5, // High priority
    process: { type: "test", data: { name: "high" } },
  });

  const normal = createEvent(sim, {
    scheduledAt: 10,
    priority: 0, // Normal high priority (default)
    process: { type: "test", data: { name: "normal" } },
  });

  sim.events = scheduleEvent(sim, veryHigh);
  sim.events = scheduleEvent(sim, high);
  sim.events = scheduleEvent(sim, normal);

  await runSimulation(sim);

  // Lower number = higher priority
  assertEquals(executionOrder, ["veryHigh", "high", "normal"]);
});

Deno.test("priority with simple events at same time", async () => {
  const sim = initializeSimulation();
  const executionOrder: string[] = [];

  const testProcess: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "test",
    initial: "log",
    steps: {
      log(_sim, _event, state) {
        executionOrder.push(state.data.name as string);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, testProcess);

  // Test simple priority ordering without parent-child complexity
  const lowPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 10,
    process: { type: "test", data: { name: "low" } },
  });

  const mediumPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 5,
    process: { type: "test", data: { name: "medium" } },
  });

  const highPriority = createEvent(sim, {
    scheduledAt: 10,
    priority: 1,
    process: { type: "test", data: { name: "high" } },
  });

  const defaultPriority = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "test", data: { name: "default" } },
  });

  sim.events = scheduleEvent(sim, lowPriority);
  sim.events = scheduleEvent(sim, mediumPriority);
  sim.events = scheduleEvent(sim, highPriority);
  sim.events = scheduleEvent(sim, defaultPriority);

  await runSimulation(sim);

  // Should process in priority order: lowest number first
  assertEquals(executionOrder, ["default", "high", "medium", "low"]);
});

Deno.test("priority with different process types", async () => {
  const sim = initializeSimulation();
  const executionOrder: string[] = [];

  const processA: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "A",
    initial: "log",
    steps: {
      log(sim, _event, state) {
        executionOrder.push(`A-${state.data.name}@${sim.currentTime}`);
        return {
          state,
          next: [],
        };
      },
    },
  };

  const processB: ProcessDefinition<{
    log: [StateData, []];
  }> = {
    type: "B",
    initial: "log",
    steps: {
      log(sim, _event, state) {
        executionOrder.push(`B-${state.data.name}@${sim.currentTime}`);
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, processA);
  sim.registry = registerProcess(sim, processB);

  // Create events and log their priorities
  const aLow = createEvent(sim, {
    scheduledAt: 10,
    priority: 5,
    process: { type: "A", data: { name: "low" } },
  });

  const bHigh = createEvent(sim, {
    scheduledAt: 10,
    priority: 1,
    process: { type: "B", data: { name: "high" } },
  });

  const aDefault = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "A", data: { name: "default" } },
  });

  sim.events = scheduleEvent(sim, aLow);
  sim.events = scheduleEvent(sim, bHigh);
  sim.events = scheduleEvent(sim, aDefault);

  await runSimulation(sim);

  assertEquals(executionOrder, ["A-default@10", "B-high@10", "A-low@10"]);
});

Deno.test("process state initialization", async () => {
  interface FooData extends StateData {
    foo?: string;
    bar: number;
  }

  const sim = initializeSimulation();

  const foo: ProcessDefinition<{
    foo: [FooData, []];
  }> = {
    type: "foo",
    initial: "foo",
    steps: {
      foo(_sim, _event, state) {
        assert(state.data.foo);
        assertEquals(state.data.foo, "baz");
        assertEquals(state.data.bar, 42.1337);

        return {
          state: { ...state },
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "foo",
      data: {
        foo: "baz",
        bar: 42.1337,
      },
    },
  });

  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  const _stop = states[states.length - 1];
});

Deno.test("process state across steps", async () => {
  interface FooData extends StateData {
    foo?: string;
    bar: number;
  }

  const sim = initializeSimulation();

  const foobar: ProcessDefinition<{
    foo: [FooData, [FooData]];
    bar: [FooData, [FooData]];
    baz: [FooData, []];
  }> = {
    type: "foobar",
    initial: "foo",
    steps: {
      foo(sim, event, state) {
        const nextEvent: Event<FooData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime + 1,
          process: {
            type: "foobar",
            inheritStep: true,
          },
        });

        return {
          state: { ...state, step: "bar" },
          next: [nextEvent],
        };
      },
      bar(_sim, event, state) {
        assert(state.data.foo);
        assertEquals(state.data.foo, "baz");
        assertEquals(state.data.bar, 42.1337);

        const nextEvent: Event<FooData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime + 1,
          process: {
            type: "foobar",
            inheritStep: true,
          },
        });

        return {
          state: { ...state, step: "baz", data: { foo: "snafu", bar: -3.14 } },
          next: [nextEvent],
        };
      },
      baz(_sim, _event, state) {
        assert(state.data.foo);
        assertEquals(state.data.foo, "snafu");
        assertEquals(state.data.bar, -3.14);

        return {
          state: { ...state },
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foobar);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "foobar",
      data: {
        foo: "baz",
        bar: 42.1337,
      },
    },
  });

  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  const _stop = states[states.length - 1];
});

Deno.test("process state inheritance (fork)", async () => {
  interface WorkerData extends StateData {
    worker: string;
    value?: number;
  }

  const sim = initializeSimulation();

  const results: Record<string, number> = {
    "main": 0,
    "worker1": 0,
    "worker2": 0,
    "worker3": 0,
  };

  const foo: ProcessDefinition<{
    main: [WorkerData, [WorkerData, WorkerData, WorkerData]];
    thread: [WorkerData, [WorkerData]];
    stop: [WorkerData, []];
  }> = {
    type: "foo",
    initial: "main",
    steps: {
      main(sim, event, state) {
        const worker1: Event<WorkerData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: 10,
          process: {
            type: "foo",
            inheritStep: true,
            data: {
              worker: "worker1",
            },
          },
        });

        const worker2: Event<WorkerData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: 20,
          process: {
            type: "foo",
            inheritStep: true,
            data: {
              worker: "worker2",
            },
          },
        });

        const worker3: Event<WorkerData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: 30,
          process: {
            type: "foo",
            inheritStep: true,
            data: {
              worker: "worker3",
            },
          },
        });

        return {
          state: { ...state, step: "thread" },
          next: [worker1, worker2, worker3],
        };
      },
      thread(sim, event, state) {
        const newState = state.data.worker === "main"
          ? { ...state, data: { ...state.data, value: 0 } }
          : state.data.worker === "worker1"
          ? { ...state, data: { ...state.data, value: 10 } }
          : state.data.worker === "worker2"
          ? { ...state, data: { ...state.data, value: 20 } }
          : state.data.worker === "worker3"
          ? { ...state, data: { ...state.data, value: 30 } }
          : { ...state };

        const nextEvent: Event<WorkerData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: sim.currentTime,
          process: {
            type: "foo",
            inheritStep: true,
          },
        });

        return {
          state: { ...newState, step: "stop" },
          next: [nextEvent],
        };
      },
      stop(_sim, _event, state) {
        const worker = state.data.worker;
        const value = state.data.value ?? -1;
        results[worker] = value;

        return {
          state: { ...state },
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "foo",
      data: {
        worker: "main",
      },
    },
  });

  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  const _stop = states[states.length - 1];

  assertEquals(results["main"], 0);
  assertEquals(results["worker1"], 10);
  assertEquals(results["worker2"], 20);
  assertEquals(results["worker3"], 30);
});

Deno.test("process state inheritance (exec)", async () => {
  interface FooData extends StateData {
    foobar: number;
  }

  const sim = initializeSimulation();

  const foo: ProcessDefinition<{
    start: [FooData, [FooData, FooData]];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const copyState: Event<FooData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: 5,
          process: {
            type: "bar",
          },
        });

        const overwriteState: Event<FooData> = createEvent(sim, {
          parent: event.id,
          scheduledAt: 10,
          process: {
            type: "bar",
            data: {
              foobar: -3.14,
            },
          },
        });

        return {
          state: {
            ...state,
            step: "start",
            data: { ...state.data, foobar: 42.1337 },
          },
          next: [copyState, overwriteState],
        };
      },
    },
  };

  const bar: ProcessDefinition<{
    start: [FooData, []];
  }> = {
    type: "bar",
    initial: "start",
    steps: {
      start(sim, _event, state) {
        if (sim.currentTime === 5) {
          assert(state.data.foobar === 42.1337);
        } else if (sim.currentTime === 10) {
          assert(state.data.foobar === -3.14);
        }

        return {
          state: { ...state },
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);
  sim.registry = registerProcess(sim, bar);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "foo",
    },
  });

  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  const _stop = states[states.length - 1];
});

Deno.test("process state inheritance (spawn)", async () => {
  interface FooData extends StateData {
    foobar: number;
  }

  const sim = initializeSimulation();

  const foo: ProcessDefinition<{
    start: [FooData, [FooData]];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, _event, state) {
        const copyState: Event<FooData> = createEvent(sim, {
          scheduledAt: 5,
          process: {
            type: "bar",
            data: {
              foobar: -3.14,
            },
          },
        });

        return {
          state: {
            ...state,
            step: "start",
            data: { ...state.data, foobar: 42.1337 },
          },
          next: [copyState],
        };
      },
    },
  };

  const bar: ProcessDefinition<{
    start: [FooData, []];
  }> = {
    type: "bar",
    initial: "start",
    steps: {
      start(_sim, _event, state) {
        assert(state.data.foobar === -3.14);

        return {
          state: { ...state },
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);
  sim.registry = registerProcess(sim, bar);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "foo",
    },
  });

  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  const _stop = states[states.length - 1];
});
