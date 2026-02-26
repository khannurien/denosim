import { assert, assertEquals } from "@std/assert";
import {
  applyDelta,
  createDelta,
  createDeltaEncodedSimulation,
  reconstructFromDeltas,
} from "../src/memory.ts";
import {
  Event,
  EventID,
  EventState,
  ProcessState,
  QueueDiscipline,
  Simulation,
} from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  runSimulationWithDeltas,
  scheduleEvent,
} from "../src/simulation.ts";
import { EventTransition, registerStore } from "../mod.ts";

function makeSim(
  time = 0,
  events: Record<string, Event> = {},
  status: Record<EventID, EventState> = {},
  transitions: EventTransition[] = [],
  state: Record<string, ProcessState> = {},
  stores: Record<string, unknown> = {},
): Simulation {
  return {
    currentTime: time,
    timeline: {
      events,
      status,
      transitions,
    },
    state,
    stores: stores as Simulation["stores"],
    registry: {},
  };
}

Deno.test("createDelta captures event/state/store mutations", () => {
  const e1: Event = {
    id: "e1",
    priority: 0,
    scheduledAt: 0,
    process: { type: "none" },
  };
  const e1Finished: Event = {
    ...e1,
  };
  const e2: Event = {
    id: "e2",
    priority: 0,
    scheduledAt: 2,
    process: { type: "none" },
  };

  const sim1 = makeSim(
    0,
    { [e1.id]: e1 },
    { [e1.id]: EventState.Scheduled },
    [],
    {
      e1: { type: "p", step: "start", data: { n: 1 } },
    },
    {
      s1: {
        id: "s1",
        capacity: 1,
        blocking: true,
        buffer: [],
        getRequests: [],
        putRequests: [],
      },
    },
  );

  const sim2 = makeSim(
    2,
    { [e1Finished.id]: e1Finished, [e2.id]: e2 },
    { [e1.id]: EventState.Finished, [e2.id]: EventState.Scheduled },
    [{ id: e1.id, state: EventState.Finished, at: 2 }],
    {
      e1: { type: "p", step: "start", data: { n: 1 } },
      e2: { type: "p", step: "start", data: { n: 3 } },
    },
    {
      s1: {
        id: "s1",
        capacity: 1,
        blocking: true,
        buffer: [],
        getRequests: [e1],
        putRequests: [],
      },
      s2: {
        id: "s2",
        capacity: 1,
        blocking: true,
        buffer: [],
        getRequests: [],
        putRequests: [],
      },
    },
  );

  const delta = createDelta(sim1, sim2);
  assertEquals(delta.c, 2);
  assertEquals(delta.e.length, 1);
  assert(delta.e.some((op) => op.op === "set" && op.key === "e2"));
  assertEquals(delta.s.length, 1);
  assert(delta.s.some((op) => op.key === "e2"));
  assertEquals(delta.st.length, 2);
  assert(delta.st.some((op) => op.op === "set" && op.key === "s1"));
  assert(delta.st.some((op) => op.op === "set" && op.key === "s2"));
});

Deno.test("delta encoding roundtrip reconstructs final state", () => {
  const sim0 = makeSim(0);
  const sim1 = makeSim(1, {}, {}, [], {
    a: { type: "p", step: "s1", data: {} },
  });
  const sim2 = makeSim(2, {}, {}, [], {
    a: { type: "p", step: "s2", data: {} },
  });

  const encoded = createDeltaEncodedSimulation([sim0, sim1, sim2]);
  const recovered = reconstructFromDeltas(encoded.base, encoded.deltas);

  assertEquals(recovered.length, 3);
  assertEquals(recovered[2], sim2);
});

Deno.test("applyDelta applies store set operations", () => {
  const req = createEvent({ scheduledAt: 0 });
  const base = makeSim(
    0,
    {},
    {},
    [],
    {},
    {
      s1: {
        id: "s1",
        capacity: 1,
        blocking: true,
        discipline: QueueDiscipline.LIFO,
        buffer: [],
        getRequests: [req],
        putRequests: [],
      },
    },
  );

  const result = applyDelta(base, {
    c: 1,
    e: [],
    es: [],
    et: [],
    s: [],
    st: [
      {
        op: "set",
        key: "s2",
        value: {
          id: "s2",
          capacity: 2,
          blocking: false,
          discipline: QueueDiscipline.FIFO,
          buffer: [],
          getRequests: [],
          putRequests: [],
        },
      },
    ],
  });

  assertEquals(result.currentTime, 1);
  assert(result.stores["s2"]);
});

Deno.test("runSimulation records only real steps and keeps full final state after dumps", async () => {
  const dir = "dumps-cadence";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();

  const initial: Event[] = [];

  for (const t of [0, 1, 2, 3, 4]) {
    const event = createEvent({ scheduledAt: t });
    initial.push(event);
    sim.timeline = scheduleEvent(sim, event);
  }

  const [encoded] = await runSimulationWithDeltas(sim, {
    runDirectory: dir,
    dumpInterval: 2,
  });

  assertEquals(encoded.current.currentTime, 4);
  assert(
    initial.every((event) =>
      encoded.current.timeline.status[event.id] === EventState.Finished
    ),
  );
  assertEquals(encoded.deltas.length, 0);

  const dump0 = await Deno.stat(`${dir}/dumps/0-t1.json`);
  const dump1 = await Deno.stat(`${dir}/dumps/1-t3.json`);
  assert(dump0.isFile);
  assert(dump1.isFile);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("runSimulation keeps base immutable and reconstructs current from deltas", async () => {
  const dir = "dumps-immutability";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();

  const event = createEvent({ scheduledAt: 0 });
  sim.timeline = scheduleEvent(sim, event);

  const [encoded] = await runSimulationWithDeltas(sim, {
    runDirectory: dir,
    dumpInterval: 100,
  });

  assertEquals(Object.keys(encoded.base.timeline.events).length, 1);
  assertEquals(encoded.base.timeline.status[event.id], EventState.Scheduled);
  assertEquals(Object.keys(encoded.base.state).length, 0);

  const replay = reconstructFromDeltas(encoded.base, encoded.deltas);
  const replayStop = replay[replay.length - 1];
  assertEquals(replayStop, encoded.current);
  assertEquals(replayStop.timeline.status[event.id], EventState.Finished);
  assertEquals(Object.keys(replayStop.state).length, 1);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkpoints preserve full replay state by default", async () => {
  const sim = initializeSimulation();
  const req1 = createEvent({ scheduledAt: 0 });
  const req2 = createEvent({ scheduledAt: 0 });
  sim.stores = registerStore(sim, {
    id: "s1",
    capacity: 1,
    blocking: true,
    discipline: QueueDiscipline.FIFO,
    buffer: [],
    getRequests: [req1],
    putRequests: [req2],
  });
  const e1 = createEvent({ scheduledAt: 0 });
  const e2 = createEvent({ scheduledAt: 1 });
  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);

  const dir = "dumps-checkpoint-compact";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const [stop] = await runSimulation(sim, {
    runDirectory: dir,
    dumpInterval: 1,
  });

  assertEquals(Object.keys(stop.timeline.events).length, 2);
  assertEquals(stop.timeline.status[e1.id], EventState.Finished);
  assertEquals(stop.timeline.status[e2.id], EventState.Finished);
  assertEquals(Object.keys(stop.state).length, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkpoints keep untilEvent semantics with full replay state", async () => {
  const sim = initializeSimulation();
  const e1 = createEvent({ scheduledAt: 10 });
  const e2 = createEvent({ scheduledAt: 20 });
  const e3 = createEvent({ scheduledAt: 30 });
  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);
  sim.timeline = scheduleEvent(sim, e3);

  const dir = "dumps-checkpoint-until-event";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const [stop, stats] = await runSimulation(sim, {
    untilEvent: e2,
    runDirectory: dir,
    dumpInterval: 1,
  });

  assertEquals(stats.end, 20);
  const handledE1 = Object.values(stop.timeline.events).find((event) =>
    event.id === e1.id
  );
  const handledE2 = Object.values(stop.timeline.events).find((event) =>
    event.id === e2.id
  );
  assert(handledE1);
  assert(handledE2);
  assertEquals(stop.timeline.status[handledE1.id], EventState.Finished);
  assertEquals(stop.timeline.status[handledE2.id], EventState.Finished);
  const remaining = Object.values(stop.timeline.events).find((event) =>
    event.id === e3.id
  );
  assert(remaining);
  assertEquals(stop.timeline.status[remaining.id], EventState.Scheduled);
  await Deno.remove(dir, { recursive: true });
});
