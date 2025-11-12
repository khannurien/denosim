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
});

Deno.test("process state across steps", async () => {
});

Deno.test("process state inheritance (fork)", async () => {
});

Deno.test("process state inheritance (exec)", async () => {
});

Deno.test("process state inheritance (spawn)", async () => {
});
