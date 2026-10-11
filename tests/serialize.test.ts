import { assert, assertEquals } from "@std/assert";

import type {
  Event,
  ProcessDefinition,
  Simulation,
  StateData,
  Store,
  StoreItemMap,
} from "../src/model.ts";
import { EventStatus, QueueDiscipline } from "../src/model.ts";
import {
  getWhere,
  initializeStore,
  put,
  registerStore,
} from "../src/stores.ts";
import { historyStates } from "../src/memory.ts";
import { runSimulation } from "../src/runner.ts";
import {
  deserializeSimulation,
  serializeSimulation,
} from "../src/serialize.ts";
import {
  continueEvent,
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

      return {
        state: {
          ...state,
          data: { ...state.data, count: state.data.count + 1 },
        },
        next: [continueEvent(event, sim.currentTime + 1)],
      };
    },
  },
};

function maxCount(state: Simulation): number {
  return Object.values(state.states).reduce((max, process) => {
    const count = process.data["count"];
    return typeof count === "number" ? Math.max(max, count) : max;
  }, 0);
}

function finishedCount(state: Simulation): number {
  return Object.values(state.timeline.events).filter((event) =>
    state.timeline.status[event.id] === EventStatus.Finished
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

  const { result } = await runSimulation(sim);

  const json = serializeSimulation(result);
  const recovered = deserializeSimulation(json, result);

  assertEquals(recovered.currentTime, 0);
  assertEquals(Object.keys(recovered.timeline.events).length, 1);
  assertEquals(recovered.states[e.id].data.value, 42);

  // Registries are left out of the serialized simulation, and passed back in
  assert(!("processes" in JSON.parse(json)));
  const restoredHandler = recovered.processes["dummy"].steps["start"];
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

  const { result } = await runSimulation(sim);
  const stop = deserializeSimulation(serializeSimulation(result), result);

  assertEquals(result.currentTime, 3);
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

  const partial = await runSimulation(firstRun, {
    until: (_sim, next) => next.scheduledAt > 2,
  });
  const restored = deserializeSimulation(
    serializeSimulation(partial.result),
    partial.result,
  );

  const resumed = await runSimulation(restored);

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
  const full = await runSimulation(fullRun);

  assertEquals(resumed.result.currentTime, full.result.currentTime);
  assertEquals(finishedCount(resumed.result), finishedCount(full.result));
  assertEquals(maxCount(resumed.result), maxCount(full.result));
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

  const { result, history } = await runSimulation(sim, { history: {} });
  assert(history);
  const timeline = historyStates(history);

  const rewindPoint = deserializeSimulation(
    serializeSimulation(timeline[3]),
    result,
  );
  const rewound = await runSimulation(rewindPoint);

  assertEquals(rewound.result.currentTime, result.currentTime);
  assertEquals(finishedCount(rewound.result), finishedCount(result));
  assertEquals(maxCount(rewound.result), maxCount(result));
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

  const { result } = await runSimulation(sim);
  const recovered = deserializeSimulation(serializeSimulation(result), result);
  const restoredHandler = recovered.processes["arrow"].steps["start"];
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
    discipline: QueueDiscipline.LIFO,
    buffer: {
      entries: [{ event: bufA, seq: 0 }, { event: bufB, seq: 1 }],
      seq: 2,
    },
    getRequests: { entries: [], seq: 0 },
    putRequests: { entries: [], seq: 0 },
    getWhereRequests: [],
  };

  // Bypass the typed API to inject the store directly
  sim.stores = { "tag-store": store };

  const { result } = await runSimulation(sim);
  const stop = deserializeSimulation(serializeSimulation(result), result);

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
  const partial = await runSimulation(sim, {
    until: (_sim, next) => next.scheduledAt > 2,
  });
  assertEquals(partial.result.currentTime, 2);
  assert(
    Object.values(partial.result.timeline.status).some(
      (s) => s === EventStatus.Scheduled,
    ),
  );

  const restored = deserializeSimulation(
    serializeSimulation(partial.result),
    partial.result,
  );

  // Continuing the simulation requires the recovered handler to fire
  const { result } = await runSimulation(restored);

  // Handler must have advanced the counter to its limit
  assertEquals(result.currentTime, 4);
  assertEquals(maxCount(result), 4);
  assertEquals(finishedCount(result), 5); // count 0→4 = 5 events
});

Deno.test("getWhereRequests survives serialization roundtrip", async () => {
  // Inject a store with a pre-populated getWhereRequests entry and verify
  // that the predicateType string is preserved across serialize → deserialize.
  const requestEvent = createEvent({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none" },
  });

  const store: Store<StateData, "fgr-store"> = {
    id: "fgr-store",
    capacity: 0,
    discipline: QueueDiscipline.LIFO,
    buffer: { entries: [], seq: 0 },
    getRequests: { entries: [], seq: 0 },
    putRequests: { entries: [], seq: 0 },
    getWhereRequests: [{
      event: requestEvent,
      predicateType: "myPredicate",
      seq: 0,
    }],
  };

  const sim = initializeSimulation();
  sim.stores = { "fgr-store": store };

  const { result } = await runSimulation(sim);
  const stop = deserializeSimulation(serializeSimulation(result), result);

  assertEquals(stop.stores["fgr-store"].getWhereRequests.length, 1);
  assertEquals(
    stop.stores["fgr-store"].getWhereRequests[0].predicateType,
    "myPredicate",
  );
});

Deno.test("pause/resume correctly resolves getWhere request after deserialization", async () => {
  interface TaskData extends StateData {
    taskId: number;
    urgent: boolean;
  }

  const TASK_STORE = "tasks" as const;
  const PREDICATE_KEY = "isUrgent";

  const scheduler: ProcessDefinition<
    { wait: TaskData; run: TaskData },
    StoreItemMap,
    { run: TaskData }
  > = {
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
      run(_sim, event, state) {
        return { state: { ...state, data: event.process.data }, next: [] };
      },
    },
  };

  const producer: ProcessDefinition<{ go: TaskData; done: TaskData }> = {
    type: "producer",
    initial: "go",
    steps: {
      go(sim, event, state) {
        // Seed non-urgent task to buffer; result discarded (buffered store seed).
        put(sim, event, TASK_STORE, { taskId: 1, urgent: false });
        // Urgent task resolves the scheduler's getWhere request.
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
    [PREDICATE_KEY]: (event: Event) => event.process?.data?.["urgent"] === true,
  };

  // First run: stop after t=0 so the scheduler blocks; producer (t=1) has not yet fired.
  const sim = initializeSimulation();
  sim.predicates = predicateRegistry;
  const store = initializeStore({
    id: TASK_STORE,
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

  const partial = await runSimulation(sim, {
    until: (_sim, next) => next.scheduledAt > 0,
  });
  assertEquals(partial.result.currentTime, 0);

  // Scheduler must be blocked: request recorded with the predicate key.
  assertEquals(
    partial.result.stores[TASK_STORE].getWhereRequests.length,
    1,
  );
  assertEquals(
    partial.result.stores[TASK_STORE].getWhereRequests[0].predicateType,
    PREDICATE_KEY,
  );

  // Serialize and deserialize, re-supplying both the process and predicate registries.
  const json = serializeSimulation(partial.result);
  const restored = deserializeSimulation(json, sim);

  // getWhereRequests must survive the roundtrip.
  assertEquals(restored.stores[TASK_STORE].getWhereRequests.length, 1);
  assertEquals(
    restored.stores[TASK_STORE].getWhereRequests[0].predicateType,
    PREDICATE_KEY,
  );

  // Resume: producer fires at t=1, resolves the getWhere request with taskId=2.
  const { result } = await runSimulation(restored);
  const schedulerState = Object.values(result.states).find(
    (s) => s.type === "scheduler" && s.data["taskId"] === 2,
  );
  assert(
    schedulerState,
    "scheduler must have received the urgent task after resume",
  );
  assertEquals(schedulerState.step, "run");
});
