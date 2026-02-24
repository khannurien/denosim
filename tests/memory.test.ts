import { assert, assertEquals } from "@std/assert";
import {
  createDelta,
  createDeltaEncodedSimulation,
  DeltaEncodedSimulation,
  dumpToDisk,
  reconstructFromDeltas,
  shouldDump,
} from "../src/memory.ts";
import {
  DumpConfig,
  Event,
  EventState,
  ProcessState,
  Simulation,
} from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulationWithDeltas,
  scheduleEvent,
} from "../src/simulation.ts";

function makeSim(
  time = 0,
  events: Event[] = [],
  state: Record<string, ProcessState> = {},
  stores: Record<string, unknown> = {},
  dump: { config: DumpConfig; count: number } | undefined = undefined,
): Simulation {
  return {
    currentTime: time,
    events,
    state,
    stores: stores as Simulation["stores"],
    registry: {},
    dump: dump ?? {
      config: { interval: 2, directory: "dumps" }, count: 0,
    },
  };
}

Deno.test("createDelta captures event/state/store mutations", () => {
  const e1: Event = {
    id: "e1",
    status: EventState.Scheduled,
    priority: 0,
    firedAt: 0,
    scheduledAt: 0,
    process: { type: "none" },
  };
  const e1Finished: Event = {
    ...e1,
    status: EventState.Finished,
    finishedAt: 0,
  };
  const e2: Event = {
    id: "e2",
    status: EventState.Scheduled,
    priority: 0,
    firedAt: 0,
    scheduledAt: 2,
    process: { type: "none" },
  };

  const sim1 = makeSim(
    0,
    [e1],
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
    [e1Finished, e2],
    {
      e1: { type: "p", step: "stop", data: { n: 2 } },
      e2: { type: "p", step: "start", data: { n: 3 } },
    },
    {
      s2: {
        id: "s2",
        capacity: 2,
        blocking: false,
        buffer: [],
        getRequests: [],
        putRequests: [],
      },
    },
  );

  const delta = createDelta(sim1, sim2);
  assertEquals(delta.t, 2);
  assertEquals(delta.e.length, 2);
  assert(delta.e.some((op) => op.op === "update" && op.id === "e1"));
  assert(delta.e.some((op) => op.op === "add" && op.event.id === "e2"));
  assertEquals(delta.s.length, 2);
  assert(delta.s.some((op) => op.key === "e1"));
  assert(delta.s.some((op) => op.key === "e2"));
  assertEquals(delta.st.length, 2);
  assert(delta.st.some((op) => op.op === "set" && op.key === "s2"));
  assert(delta.st.some((op) => op.op === "delete" && op.key === "s1"));
});

Deno.test("delta encoding roundtrip reconstructs final state", () => {
  const sim0 = makeSim(0);
  const sim1 = makeSim(1, [], { a: { type: "p", step: "s1", data: {} } });
  const sim2 = makeSim(2, [], { a: { type: "p", step: "s2", data: {} } });

  const encoded = createDeltaEncodedSimulation([sim0, sim1, sim2]);
  const recovered = reconstructFromDeltas(encoded.base, encoded.deltas);

  assertEquals(recovered.length, 3);
  assertEquals(recovered[2], sim2);
});

Deno.test("shouldDump depends on local delta window only", () => {
  const sim = makeSim(0);
  const deltaEncoded: DeltaEncodedSimulation = {
    base: sim,
    deltas: [{ t: 1, e: [], s: [], st: [] }],
    current: {
      ...sim,
      currentTime: 1,
      dump: {
        config: { interval: 2, directory: "dumps" },
        count: 4,
      },
    },
  };

  assertEquals(shouldDump(deltaEncoded), false);
  deltaEncoded.deltas.push({ t: 2, e: [], s: [], st: [] });
  assertEquals(shouldDump(deltaEncoded), true);
});

Deno.test("dumpToDisk writes a checkpoint and resets local dump cursor", async () => {
  const dir = "dumps-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });

  const sim = makeSim(0, [], {}, {}, {
    config: { interval: 1, directory: dir },
    count: 0,
  });
  const deltaEncoded: DeltaEncodedSimulation = {
    base: sim,
    deltas: [{ t: 1, e: [], s: [], st: [] }],
    current: { ...sim, currentTime: 1 },
  };

  const updated = await dumpToDisk(deltaEncoded);
  const stat = await Deno.stat(`${dir}/dump-0.json`);
  assert(stat.isFile);
  assertEquals(updated.dump.count, 1);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("runSimulation records only real steps and dumps every interval window", async () => {
  const dir = "dumps-cadence";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();
  sim.dump.config.directory = dir;
  sim.dump.config.interval = 2;

  for (const t of [0, 1, 2, 3, 4]) {
    const event = createEvent(sim, { scheduledAt: t });
    sim.events = scheduleEvent(sim, event);
  }

  const [encoded] = await runSimulationWithDeltas(sim);

  assertEquals(encoded.current.events.length, 5);
  assert(
    encoded.current.events.every((event) =>
      event.status === EventState.Finished
    ),
  );
  assertEquals(encoded.current.dump.count, 2);
  assertEquals(encoded.deltas.length, 1);

  const dump0 = await Deno.stat(`${dir}/dump-0.json`);
  const dump1 = await Deno.stat(`${dir}/dump-1.json`);
  assert(dump0.isFile);
  assert(dump1.isFile);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("runSimulation keeps base immutable and reconstructs current from deltas", async () => {
  const dir = "dumps-immutability";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();
  sim.dump.config.directory = dir;
  sim.dump.config.interval = 100;

  const event = createEvent(sim, { scheduledAt: 0 });
  sim.events = scheduleEvent(sim, event);

  const [encoded] = await runSimulationWithDeltas(sim);

  assertEquals(encoded.base.events.length, 1);
  assertEquals(encoded.base.events[0].status, EventState.Scheduled);
  assertEquals(Object.keys(encoded.base.state).length, 0);

  const replay = reconstructFromDeltas(encoded.base, encoded.deltas);
  const replayStop = replay[replay.length - 1];
  assertEquals(replayStop, encoded.current);
  assertEquals(replayStop.events[0].status, EventState.Finished);
  assertEquals(Object.keys(replayStop.state).length, 1);

  await Deno.remove(dir, { recursive: true });
});
