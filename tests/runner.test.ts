import { assert, assertEquals, assertRejects } from "@std/assert";

import type { DeltaEncodedSimulation } from "../src/memory.ts";
import type { ProcessDefinition, Simulation, StateData } from "../src/model.ts";
import { EventState } from "../src/model.ts";
import {
  dumpToDisk,
  initializeRun,
  loadRunHistory,
  reconstructFullCurrent,
  runSimulation,
  runSimulationWithDeltas,
  shouldDump,
} from "../src/runner.ts";
import { serializeSimulation } from "../src/serialize.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  scheduleEvent,
} from "../src/simulation.ts";

Deno.test("shouldDump depends on local delta window only", () => {
  const sim = initializeSimulation();
  const deltaEncoded: DeltaEncodedSimulation = {
    base: sim,
    deltas: [{ c: 1, e: [], es: [], et: [], s: [], st: [] }],
    current: {
      ...sim,
      currentTime: 1,
    },
  };

  assertEquals(shouldDump(deltaEncoded, 2), false);
  deltaEncoded.deltas.push({ c: 2, e: [], es: [], et: [], s: [], st: [] });
  assertEquals(shouldDump(deltaEncoded, 2), true);
});

Deno.test("dumpToDisk writes a checkpoint file", async () => {
  const dir = "runs/test/run-dumps-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();
  const deltaEncoded: DeltaEncodedSimulation = {
    base: sim,
    deltas: [{ c: 1, e: [], es: [], et: [], s: [], st: [] }],
    current: { ...sim, currentTime: 1 },
  };

  const runContext = await initializeRun({ runDirectory: dir });
  await dumpToDisk(serializeSimulation(deltaEncoded), 1, runContext);
  const stat = await Deno.stat(`${dir}/dumps/0-t1.json`);
  assert(stat.isFile);

  const raw = JSON.parse(await Deno.readTextFile(`${dir}/dumps/0-t1.json`));
  assertEquals(raw.deltas.length, 1);
  assertEquals(raw.base.currentTime, 0);
  assertEquals(raw.current.currentTime, 1);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("initializeRun reuses existing manifest dump state", async () => {
  const dir = "runs/test/run-resume-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const manifest = {
    runId: "resume-1",
    createdAt: now,
    updatedAt: now,
    runRoot: dir,
    dump: {
      directory: `${dir}/custom-dumps`,
      interval: 7,
      count: 42,
      lastFile: "41-t99.json",
    },
    metadata: { source: "test" },
  };
  await Deno.writeTextFile(
    `${dir}/run.json`,
    JSON.stringify(manifest, null, 2),
  );

  const context = await initializeRun({ runDirectory: dir });
  assertEquals(context.manifest.dump.directory, `${dir}/custom-dumps`);
  assertEquals(context.manifest.dump.interval, 7);
  assertEquals(context.manifest.dump.count, 42);
  assertEquals(context.manifest.dump.lastFile, "41-t99.json");
  assertEquals(context.manifest.metadata?.source, "test");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("initializeRun rejects invalid run.json", async () => {
  const dir = "runs/test/run-invalid-manifest-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/run.json`, "{ not valid json");

  await assertRejects(
    () => initializeRun({ runDirectory: dir, dumpInterval: 3 }),
    SyntaxError,
  );

  await Deno.remove(dir, { recursive: true });
});

Deno.test("reconstructFullCurrent merges checkpoint files with in-memory state", async () => {
  const dir = "runs/test/reconstruct-full-current-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // Create a simple process
  const sim = initializeSimulation();
  const simpleProcess: ProcessDefinition<{
    start: StateData;
  }> = {
    type: "reconstruct-test",
    initial: "start",
    steps: {
      start: (_sim, _event, state) => {
        return {
          state: { ...state, completed: true },
          next: [],
        };
      },
    },
  };

  sim.processes = registerProcess(sim, simpleProcess);

  // Create and run first checkpoint
  const e1 = createEvent({
    scheduledAt: 0,
    process: { type: "reconstruct-test" },
  });
  sim.timeline = scheduleEvent(sim, e1);

  await runSimulationWithDeltas(sim, {
    runDirectory: dir,
    dumpInterval: 1,
  });

  // Create checkpoint file path
  const checkpointFiles = [
    `${dir}/dumps/0-t0.json`,
  ];

  // Verify checkpoint file exists
  const checkpointStat = await Deno.stat(checkpointFiles[0]);
  assert(checkpointStat.isFile);

  // Create in-memory tail with additional events
  const tailSim = initializeSimulation();
  tailSim.processes = sim.processes;
  const e2 = createEvent({
    scheduledAt: 1,
    process: { type: "reconstruct-test" },
  });
  tailSim.timeline = scheduleEvent(tailSim, e2);
  const { result } = await runSimulation(tailSim);

  // Reconstruct full current state from checkpoints and tail
  const reconstructed = await reconstructFullCurrent(checkpointFiles, result);

  // e1 comes from the checkpoint file, e2 from the tail — both must be present
  assert(
    reconstructed.timeline.events[e1.id],
    "e1 from checkpoint must be present",
  );
  assert(reconstructed.timeline.events[e2.id], "e2 from tail must be present");
  assertEquals(reconstructed.timeline.status[e1.id], EventState.Finished);
  assertEquals(reconstructed.timeline.status[e2.id], EventState.Finished);

  // Clean up
  await Deno.remove(dir, { recursive: true });
});

Deno.test("reconstructFullCurrent handles empty checkpoints", async () => {
  const tail = initializeSimulation();

  // Test with empty checkpoint array
  const reconstructed = await reconstructFullCurrent([], tail);

  // Should return the tail unchanged
  assertEquals(reconstructed, tail);
});

// ── loadRunHistory ────────────────────────────────────────────────────────────

interface CounterState extends StateData {
  count: number;
}

/**
 * Builds a simulation with a counter process that ticks at t=1, 2, ..., endTime.
 * Each tick schedules the next event at currentTime+1 until endTime is reached.
 */
function buildCounterSim(endTime: number): Simulation {
  const sim = initializeSimulation();

  const counter: ProcessDefinition<{ tick: CounterState }> = {
    type: "counter",
    initial: "tick",
    steps: {
      tick(sim, event, state) {
        const count = state.data.count + 1;
        const nextAt = sim.currentTime + 1;
        return {
          state: { ...state, data: { count } },
          next: nextAt <= endTime
            ? [createEvent({
              parent: event.id,
              scheduledAt: nextAt,
              process: { type: "counter", inheritStep: true, data: { count } },
            })]
            : [],
        };
      },
    },
  };

  sim.processes = registerProcess(sim, counter);
  sim.timeline = scheduleEvent(
    sim,
    createEvent({
      scheduledAt: 1,
      process: { type: "counter", data: { count: 0 } },
    }),
  );

  return sim;
}

Deno.test("loadRunHistory returns empty array when run directory does not exist", async () => {
  const sim = initializeSimulation();
  const states = await loadRunHistory(
    `runs/test/nonexistent-${crypto.randomUUID()}`,
    sim.processes,
    sim.disciplines,
    sim.predicates,
  );
  assertEquals(states, []);
});

Deno.test("loadRunHistory returns empty array when no dump files exist", async () => {
  const dir = "runs/test/load-history-no-dumps";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // initializeRun creates run.json and the dumps/ dir, but no dump files yet.
  await initializeRun({ runDirectory: dir });

  const sim = initializeSimulation();
  const states = await loadRunHistory(
    dir,
    sim.processes,
    sim.disciplines,
    sim.predicates,
  );
  assertEquals(states, []);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadRunHistory reconstructs states from a single dump file", async () => {
  const dir = "runs/test/load-history-single-dump";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // 3 events at t=1,2,3; dumpInterval=2 fires after t=2 → one dump file (0-t2.json).
  // The event at t=3 lands in the final in-memory window and is NOT on disk —
  // that is the documented limitation of loadRunHistory.
  const sim = buildCounterSim(3);
  await runSimulationWithDeltas(sim, { runDirectory: dir, dumpInterval: 2 });

  const states = await loadRunHistory(
    dir,
    sim.processes,
    sim.disciplines,
    sim.predicates,
  );

  // base(ct=0) + event at t=1 + event at t=2 = 3 states.
  // ct=3 is absent: it was in the tail window that never reached the dump threshold.
  assertEquals(states.length, 3);
  assertEquals(states[0].currentTime, 0);
  assertEquals(states[1].currentTime, 1);
  assertEquals(states[2].currentTime, 2);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadRunHistory stitches multiple dump windows without duplicating boundary times", async () => {
  const dir = "runs/test/load-history-multi-dump";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // 6 events at t=1..6; dumpInterval=3 fires after t=3 and again after t=6.
  // Dump 0 (0-t3.json): base(ct=0) + deltas for t=1,2,3 → states [ct=0,1,2,3].
  // Dump 1 (1-t6.json): base=pruned(ct=3) + deltas for t=4,5,6 → states [ct=3,4,5,6].
  // When stitching, states[0] of dump 1 (the pruned ct=3 boundary) is skipped
  // so ct=3 appears exactly once in the result (from dump 0).
  const sim = buildCounterSim(6);
  await runSimulationWithDeltas(sim, { runDirectory: dir, dumpInterval: 3 });

  const states = await loadRunHistory(
    dir,
    sim.processes,
    sim.disciplines,
    sim.predicates,
  );

  assertEquals(states.length, 7);
  assertEquals(
    states.map((s) => s.currentTime),
    [0, 1, 2, 3, 4, 5, 6],
  );

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadRunHistory sorts dump files by sequence number, not lexicographically", async () => {
  const dir = "runs/test/load-history-sort";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // 22 events at t=1..22; dumpInterval=2 produces 11 dump files (0-t2.json … 10-t22.json).
  // A lexicographic sort would place "10-t22.json" between "1-t4.json" and "2-t6.json",
  // corrupting the state sequence. The correct sort uses the integer sequence prefix.
  const sim = buildCounterSim(22);
  await runSimulationWithDeltas(sim, { runDirectory: dir, dumpInterval: 2 });

  const states = await loadRunHistory(
    dir,
    sim.processes,
    sim.disciplines,
    sim.predicates,
  );

  // With correct sort the last state must be ct=22.
  // With lexicographic sort "10" sorts before "2", so the last processed window
  // would be "9-t20.json" and the last state would be ct=20 instead.
  assertEquals(states[states.length - 1].currentTime, 22);

  // All times must be monotonically non-decreasing.
  for (let i = 1; i < states.length; i++) {
    assert(
      states[i].currentTime >= states[i - 1].currentTime,
      `time went backward at index ${i}: ${states[i - 1].currentTime} → ${
        states[i].currentTime
      }`,
    );
  }

  await Deno.remove(dir, { recursive: true });
});
