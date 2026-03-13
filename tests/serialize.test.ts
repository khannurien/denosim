import { assert, assertEquals } from "@std/assert";

import type {
  ProcessDefinition,
  Simulation,
  StateData,
  Store,
} from "../src/model.ts";
import { EventState, QueueDiscipline } from "../src/model.ts";
import {
  continueEvent,
  getWhere,
  initializeStore,
  put,
  registerStore,
} from "../src/resources.ts";
import { runSimulationWithDeltas } from "../src/runner.ts";
import {
  deserializeSimulation,
  serializeSimulation,
} from "../src/serialize.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  scheduleEvent,
} from "../src/simulation.ts";

interface CounterData extends StateData {
  count: number;
  limit: number;
}

const counter: ProcessDefinition<{
  tick: CounterData;
}> = {
  type: "counter",
  initial: "tick",
  steps: {
    tick(sim, event, state) {
      if (state.data.count >= state.data.limit) {
        return { state, next: [] };
      }

      const next = continueEvent(event, sim.currentTime + 1, {
        count: state.data.count + 1,
        limit: state.data.limit,
      });

      return { state, next: [next] };
    },
  },
};

function maxCount(state: Simulation): number {
  return Object.values(state.state).reduce((max, process) => {
    const count = process.data["count"];
    return typeof count === "number" ? Math.max(max, count) : max;
  }, 0);
}

function finishedCount(state: Simulation): number {
  return Object.values(state.timeline.events).filter((event) =>
    state.timeline.status[event.id] === EventState.Finished
  ).length;
}

Deno.test("basic serialization", async () => {
  const sim = initializeSimulation();

  interface DummyData extends StateData {
    value: number;
  }

  const dummy: ProcessDefinition<{
    start: DummyData;
  }> = {
    type: "dummy",
    initial: "start",
    steps: {
      start(_sim, _event, state) {
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.processes = registerProcess(sim, dummy);

  const e = createEvent({
    scheduledAt: 0,
    process: {
      type: "dummy",
      data: { value: 42 },
    },
  });

  sim.timeline = scheduleEvent(sim, e);

  const { result } = await runSimulationWithDeltas(sim);

  const json = serializeSimulation(result);
  const recovered = deserializeSimulation(
    json,
    result.current.processes,
    result.current.disciplines,
    result.current.predicates,
  );

  assertEquals(recovered.length, result.deltas.length + 1);
  assertEquals(recovered[recovered.length - 1].currentTime, 0);
  assertEquals(
    Object.keys(recovered[recovered.length - 1].timeline.events).length,
    1,
  );
  assertEquals(recovered[recovered.length - 1].state[e.id].data.value, 42);

  const restoredHandler = recovered[0].processes["dummy"].steps["start"];
  assert(typeof restoredHandler === "function");
});

Deno.test("process state serialization", async () => {
  const sim = initializeSimulation();
  sim.processes = registerProcess(sim, counter);

  const start = createEvent({
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 3 },
    },
  });
  sim.timeline = scheduleEvent(sim, start);

  const { result } = await runSimulationWithDeltas(sim);
  const recovered = deserializeSimulation(
    serializeSimulation(result),
    result.current.processes,
    result.current.disciplines,
    result.current.predicates,
  );
  const stop = recovered[recovered.length - 1];

  assertEquals(result.current.currentTime, 3);
  assertEquals(finishedCount(stop), 4);
  assertEquals(maxCount(stop), 3);
});

Deno.test("process resume across runs", async () => {
  const firstRun = initializeSimulation();
  firstRun.processes = registerProcess(firstRun, counter);

  const start = createEvent({
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 4 },
    },
  });
  firstRun.timeline = scheduleEvent(firstRun, start);

  const partial = await runSimulationWithDeltas(firstRun, { untilTime: 2 });
  const recovered = deserializeSimulation(
    serializeSimulation(partial.result),
    partial.result.current.processes,
    partial.result.current.disciplines,
    partial.result.current.predicates,
  );
  const checkpoint = recovered[recovered.length - 1];

  const resumed = await runSimulationWithDeltas(checkpoint);

  const fullRun = initializeSimulation();
  fullRun.processes = registerProcess(fullRun, counter);
  const fullStart = createEvent({
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 4 },
    },
  });
  fullRun.timeline = scheduleEvent(fullRun, fullStart);
  const full = await runSimulationWithDeltas(fullRun);

  assertEquals(
    resumed.result.current.currentTime,
    full.result.current.currentTime,
  );
  assertEquals(
    finishedCount(resumed.result.current),
    finishedCount(full.result.current),
  );
  assertEquals(maxCount(resumed.result.current), maxCount(full.result.current));
});

Deno.test("process rewind", async () => {
  const sim = initializeSimulation();
  sim.processes = registerProcess(sim, counter);

  const start = createEvent({
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 5 },
    },
  });
  sim.timeline = scheduleEvent(sim, start);

  const { result } = await runSimulationWithDeltas(sim);
  const timeline = deserializeSimulation(
    serializeSimulation(result),
    result.current.processes,
    result.current.disciplines,
    result.current.predicates,
  );

  const rewindPoint = timeline[3];
  const rewound = await runSimulationWithDeltas(rewindPoint);

  assertEquals(rewound.result.current.currentTime, result.current.currentTime);
  assertEquals(
    finishedCount(rewound.result.current),
    finishedCount(result.current),
  );
  assertEquals(maxCount(rewound.result.current), maxCount(result.current));
});

Deno.test("serialize handles arrow-function handlers", async () => {
  const sim = initializeSimulation();

  interface ArrowData extends StateData {
    value: number;
  }

  const arrow: ProcessDefinition<{
    start: ArrowData;
  }> = {
    type: "arrow",
    initial: "start",
    steps: {
      start: (_sim, _event, state) => ({
        state,
        next: [],
      }),
    },
  };

  sim.processes = registerProcess(sim, arrow);
  const event = createEvent({
    scheduledAt: 0,
    process: {
      type: "arrow",
      data: { value: 1 },
    },
  });
  sim.timeline = scheduleEvent(sim, event);

  const { result } = await runSimulationWithDeltas(sim);
  const recovered = deserializeSimulation(
    serializeSimulation(result),
    result.current.processes,
    result.current.disciplines,
    result.current.predicates,
  );
  const restoredHandler = recovered[0].processes["arrow"].steps["start"];
  assert(typeof restoredHandler === "function");
});

Deno.test("store state survives serialization roundtrip", async () => {
  const sim = initializeSimulation();

  // Build two proper Event objects to sit in the store buffer
  const bufA = createEvent({
    scheduledAt: 0,
    process: { type: "none", data: { tag: "alpha" } },
  });
  const bufB = createEvent({
    scheduledAt: 0,
    process: { type: "none", data: { tag: "beta" } },
  });

  const store: Store<StateData, "tag-store"> = {
    id: "tag-store",
    capacity: 3,
    blocking: false,
    discipline: QueueDiscipline.LIFO,
    buffer: {
      entries: [{ event: bufA, seq: 0 }, { event: bufB, seq: 1 }],
      seq: 2,
    },
    getRequests: { entries: [], seq: 0 },
    putRequests: { entries: [], seq: 0 },
    filteredGetRequests: [],
  };

  // Bypass the typed API to inject the store directly
  sim.stores = { "tag-store": store };

  const { result } = await runSimulationWithDeltas(sim);
  const recovered = deserializeSimulation(
    serializeSimulation(result),
    result.current.processes,
    result.current.disciplines,
    result.current.predicates,
  );
  const stop = recovered[recovered.length - 1];

  assertEquals(stop.stores["tag-store"].buffer.entries.length, 2);
  const tags = stop.stores["tag-store"].buffer.entries
    .map(({ event: e }) => e.process.data?.["tag"])
    .sort();
  assertEquals(tags, ["alpha", "beta"]);
});

Deno.test("recovered handler executes correctly on continued simulation", async () => {
  const sim = initializeSimulation();
  sim.processes = registerProcess(sim, counter);

  const start = createEvent({
    scheduledAt: 0,
    process: { type: "counter", data: { count: 0, limit: 4 } },
  });
  sim.timeline = scheduleEvent(sim, start);

  // Run only halfway; pending events must remain for the handler to fire later
  const partial = await runSimulationWithDeltas(sim, { untilTime: 2 });
  assertEquals(partial.result.current.currentTime, 2);
  assert(
    Object.values(partial.result.current.timeline.status).some(
      (s) => s === EventState.Scheduled,
    ),
  );

  const recovered = deserializeSimulation(
    serializeSimulation(partial.result),
    partial.result.current.processes,
    partial.result.current.disciplines,
    partial.result.current.predicates,
  );
  const checkpoint = recovered[recovered.length - 1];

  // Continuing the simulation requires the recovered handler to fire
  const { result } = await runSimulationWithDeltas(checkpoint);

  // Handler must have advanced the counter to its limit
  assertEquals(result.current.currentTime, 4);
  assertEquals(maxCount(result.current), 4);
  assertEquals(finishedCount(result.current), 5); // count 0→4 = 5 events
});

Deno.test("filteredGetRequests survives serialization roundtrip", async () => {
  // Inject a store with a pre-populated filteredGetRequests entry and verify
  // that the predicateType string is preserved across serialize → deserialize.
  const waiterEvent = createEvent({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none" },
  });

  const store: Store<StateData, "fgr-store"> = {
    id: "fgr-store",
    capacity: 1,
    blocking: true,
    discipline: QueueDiscipline.LIFO,
    buffer: { entries: [], seq: 0 },
    getRequests: { entries: [], seq: 0 },
    putRequests: { entries: [], seq: 0 },
    filteredGetRequests: [{ event: waiterEvent, predicateType: "myPredicate" }],
  };

  const sim = initializeSimulation();
  sim.stores = { "fgr-store": store };

  const { result } = await runSimulationWithDeltas(sim);
  const recovered = deserializeSimulation(
    serializeSimulation(result),
    result.current.processes,
    result.current.disciplines,
    result.current.predicates,
  );
  const stop = recovered[recovered.length - 1];

  assertEquals(stop.stores["fgr-store"].filteredGetRequests.length, 1);
  assertEquals(
    stop.stores["fgr-store"].filteredGetRequests[0].predicateType,
    "myPredicate",
  );
});

Deno.test("pause/resume correctly resolves getWhere waiter after deserialization", async () => {
  interface TaskData extends StateData {
    taskId: number;
    urgent: boolean;
  }

  const TASK_STORE = "tasks" as const;
  const PREDICATE_KEY = "isUrgent";

  const scheduler: ProcessDefinition<{ wait: TaskData; run: TaskData }> = {
    type: "scheduler",
    initial: "wait",
    steps: {
      wait(sim, event, state) {
        const { step, resume, finish } = getWhere(
          sim,
          event,
          TASK_STORE,
          PREDICATE_KEY,
        );
        return {
          state: { ...state, step: "run" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      run(_sim, _event, state) {
        return { state, next: [] };
      },
    },
  };

  const producer: ProcessDefinition<{ go: TaskData; done: TaskData }> = {
    type: "producer",
    initial: "go",
    steps: {
      go(sim, event, state) {
        // Seed non-urgent task to buffer; result discarded (non-blocking store seed).
        put(sim, event, TASK_STORE, { taskId: 1, urgent: false });
        // Urgent task resolves the scheduler's getWhere waiter.
        const { step, resume, finish } = put(sim, event, TASK_STORE, {
          taskId: 2,
          urgent: true,
        });
        return {
          state: { ...state, step: "done" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      done(_sim, _event, state) {
        return { state, next: [] };
      },
    },
  };

  const predicateRegistry = {
    [PREDICATE_KEY]: (d: StateData) => d["urgent"] === true,
  };

  // First run: stop after t=0 so the scheduler blocks; producer (t=1) has not yet fired.
  const sim = initializeSimulation();
  sim.predicates = predicateRegistry;
  const store = initializeStore({
    id: TASK_STORE,
    blocking: false,
    capacity: 10,
  });
  sim.stores = registerStore(sim, store);
  sim.processes = registerProcess(sim, scheduler);
  sim.processes = registerProcess(sim, producer);

  const schedEvent = createEvent({
    scheduledAt: 0,
    process: { type: "scheduler", data: { taskId: 0, urgent: false } },
  });
  const prodEvent = createEvent({
    scheduledAt: 1,
    process: { type: "producer", data: { taskId: 0, urgent: false } },
  });
  sim.timeline = scheduleEvent(sim, schedEvent);
  sim.timeline = scheduleEvent(sim, prodEvent);

  const partial = await runSimulationWithDeltas(sim, { untilTime: 0 });
  assertEquals(partial.result.current.currentTime, 0);

  // Scheduler must be blocked: waiter recorded with the predicate key.
  assertEquals(
    partial.result.current.stores[TASK_STORE].filteredGetRequests.length,
    1,
  );
  assertEquals(
    partial.result.current.stores[TASK_STORE].filteredGetRequests[0]
      .predicateType,
    PREDICATE_KEY,
  );

  // Serialize and deserialize, re-supplying both the process and predicate registries.
  const json = serializeSimulation(partial.result);
  const recovered = deserializeSimulation(
    json,
    sim.processes,
    sim.disciplines,
    sim.predicates,
  );
  const checkpoint = recovered[recovered.length - 1];

  // filteredGetRequests must survive the roundtrip.
  assertEquals(checkpoint.stores[TASK_STORE].filteredGetRequests.length, 1);
  assertEquals(
    checkpoint.stores[TASK_STORE].filteredGetRequests[0].predicateType,
    PREDICATE_KEY,
  );

  // Resume: producer fires at t=1, resolves the getWhere waiter with taskId=2.
  const { result } = await runSimulationWithDeltas(checkpoint);
  const schedulerState = Object.values(result.current.state).find(
    (s) => s.type === "scheduler" && s.data["taskId"] === 2,
  );
  assert(
    schedulerState,
    "scheduler must have received the urgent task after resume",
  );
  assertEquals(schedulerState.step, "run");
});
