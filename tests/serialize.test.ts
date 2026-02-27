import { assert, assertEquals } from "@std/assert";

import {
  EventState,
  ProcessDefinition,
  QueueDiscipline,
  StateData,
  Store,
} from "../src/model.ts";
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

      const next = createEvent({
        parent: event.id,
        scheduledAt: sim.currentTime + 1,
        process: {
          type: "counter",
          inheritStep: true,
          data: {
            count: state.data.count + 1,
            limit: state.data.limit,
          },
        },
      });

      return { state, next: [next] };
    },
  },
};

function maxCount(state: ReturnType<typeof initializeSimulation>): number {
  return Object.values(state.state).reduce((max, process) => {
    const count = process.data["count"];
    return typeof count === "number" ? Math.max(max, count) : max;
  }, 0);
}

function finishedCount(state: ReturnType<typeof initializeSimulation>): number {
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

  sim.registry = registerProcess(sim, dummy);

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
  const recovered = deserializeSimulation(json, result.current.registry);

  assertEquals(recovered.length, result.deltas.length + 1);
  assertEquals(recovered[recovered.length - 1].currentTime, 0);
  assertEquals(
    Object.keys(recovered[recovered.length - 1].timeline.events).length,
    1,
  );
  assertEquals(recovered[recovered.length - 1].state[e.id].data.value, 42);

  const restoredHandler = recovered[0].registry["dummy"].steps["start"];
  assert(typeof restoredHandler === "function");
});

Deno.test("process state serialization", async () => {
  const sim = initializeSimulation();
  sim.registry = registerProcess(sim, counter);

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
    result.current.registry,
  );
  const stop = recovered[recovered.length - 1];

  assertEquals(result.current.currentTime, 3);
  assertEquals(finishedCount(stop), 4);
  assertEquals(maxCount(stop), 3);
});

Deno.test("process resume across runs", async () => {
  const firstRun = initializeSimulation();
  firstRun.registry = registerProcess(firstRun, counter);

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
    partial.result.current.registry,
  );
  const checkpoint = recovered[recovered.length - 1];

  const resumed = await runSimulationWithDeltas(checkpoint);

  const fullRun = initializeSimulation();
  fullRun.registry = registerProcess(fullRun, counter);
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
  sim.registry = registerProcess(sim, counter);

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
    result.current.registry,
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

  sim.registry = registerProcess(sim, arrow);
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
    result.current.registry,
  );
  const restoredHandler = recovered[0].registry["arrow"].steps["start"];
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
    buffer: [bufA, bufB],
    getRequests: [],
    putRequests: [],
  };

  // Bypass the typed API to inject the store directly
  sim.stores = { "tag-store": store } as unknown as typeof sim.stores;

  const { result } = await runSimulationWithDeltas(sim);
  const recovered = deserializeSimulation(
    serializeSimulation(result),
    result.current.registry,
  );
  const stop = recovered[recovered.length - 1];

  assertEquals(stop.stores["tag-store"].buffer.length, 2);
  const tags = stop.stores["tag-store"].buffer
    .map((e) => e.process.data?.["tag"])
    .sort();
  assertEquals(tags, ["alpha", "beta"]);
});

Deno.test("recovered handler executes correctly on continued simulation", async () => {
  const sim = initializeSimulation();
  sim.registry = registerProcess(sim, counter);

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
    partial.result.current.registry,
  );
  const checkpoint = recovered[recovered.length - 1];

  // Continuing the simulation requires the recovered handler to fire
  const { result } = await runSimulationWithDeltas(checkpoint);

  // Handler must have advanced the counter to its limit
  assertEquals(result.current.currentTime, 4);
  assertEquals(maxCount(result.current), 4);
  assertEquals(finishedCount(result.current), 5); // count 0→4 = 5 events
});
