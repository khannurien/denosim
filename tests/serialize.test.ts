import { assert, assertEquals } from "@std/assert";
import {
  createEvent,
  deserializeSimulation,
  EventState,
  initializeSimulation,
  ProcessDefinition,
  registerProcess,
  runSimulationWithDeltas,
  scheduleEvent,
  serializeSimulation,
  StateData,
} from "../mod.ts";

interface CounterData extends StateData {
  count: number;
  limit: number;
}

const counter: ProcessDefinition<{
  tick: [CounterData, [CounterData] | []];
}> = {
  type: "counter",
  initial: "tick",
  steps: {
    tick(sim, event, state) {
      if (state.data.count >= state.data.limit) {
        return { state, next: [] };
      }

      // Keep handler closure-free so it survives serialize/deserialize + eval.
      const next = {
        id: crypto.randomUUID(),
        parent: event.id,
        status: "Fired" as EventState,
        priority: 0,
        firedAt: sim.currentTime,
        scheduledAt: sim.currentTime + 1,
        process: {
          type: "counter",
          inheritStep: true,
          data: {
            count: state.data.count + 1,
            limit: state.data.limit,
          },
        },
      };

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
  return state.events.filter((event) => event.status === EventState.Finished)
    .length;
}

Deno.test("basic serialization", async () => {
  const sim = initializeSimulation();

  interface DummyData extends StateData {
    value: number;
  }

  const dummy: ProcessDefinition<{
    start: [DummyData, []];
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

  const e = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "dummy",
      data: { value: 42 },
    },
  });

  sim.events = scheduleEvent(sim, e);

  const [encoded, _stats] = await runSimulationWithDeltas(sim);

  const json = serializeSimulation(encoded);
  const recovered = deserializeSimulation(json);

  assertEquals(recovered.length, encoded.deltas.length + 1);
  assertEquals(recovered[recovered.length - 1].currentTime, 0);
  assertEquals(recovered[recovered.length - 1].events.length, 1);
  assertEquals(recovered[recovered.length - 1].state[e.id].data.value, 42);

  const restoredHandler = recovered[0].registry["dummy"].steps["start"];
  assert(typeof restoredHandler === "function");
});

Deno.test("process state serialization", async () => {
  const sim = initializeSimulation();
  sim.registry = registerProcess(sim, counter);

  const start = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 3 },
    },
  });
  sim.events = scheduleEvent(sim, start);

  const [encoded] = await runSimulationWithDeltas(sim);
  const recovered = deserializeSimulation(serializeSimulation(encoded));
  const stop = recovered[recovered.length - 1];

  assertEquals(stop.currentTime, 3);
  assertEquals(finishedCount(stop), 4);
  assertEquals(maxCount(stop), 3);
});

Deno.test("process resume across runs", async () => {
  const firstRun = initializeSimulation();
  firstRun.registry = registerProcess(firstRun, counter);

  const start = createEvent(firstRun, {
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 4 },
    },
  });
  firstRun.events = scheduleEvent(firstRun, start);

  const [partial] = await runSimulationWithDeltas(firstRun, { untilTime: 2 });
  const recovered = deserializeSimulation(serializeSimulation(partial));
  const checkpoint = recovered[recovered.length - 1];

  const [resumed] = await runSimulationWithDeltas(checkpoint);

  const fullRun = initializeSimulation();
  fullRun.registry = registerProcess(fullRun, counter);
  const fullStart = createEvent(fullRun, {
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 4 },
    },
  });
  fullRun.events = scheduleEvent(fullRun, fullStart);
  const [full] = await runSimulationWithDeltas(fullRun);

  assertEquals(resumed.current.currentTime, full.current.currentTime);
  assertEquals(finishedCount(resumed.current), finishedCount(full.current));
  assertEquals(maxCount(resumed.current), maxCount(full.current));
});

Deno.test("process rewind", async () => {
  const sim = initializeSimulation();
  sim.registry = registerProcess(sim, counter);

  const start = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "counter",
      data: { count: 0, limit: 5 },
    },
  });
  sim.events = scheduleEvent(sim, start);

  const [encoded] = await runSimulationWithDeltas(sim);
  const timeline = deserializeSimulation(serializeSimulation(encoded));

  const rewindPoint = timeline[3];
  const [rewound] = await runSimulationWithDeltas(rewindPoint);

  assertEquals(rewound.current.currentTime, encoded.current.currentTime);
  assertEquals(finishedCount(rewound.current), finishedCount(encoded.current));
  assertEquals(maxCount(rewound.current), maxCount(encoded.current));
});
