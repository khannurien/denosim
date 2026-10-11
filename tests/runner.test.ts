import { assert, assertEquals, assertRejects } from "@std/assert";

import type { HistoryWindow } from "../src/memory.ts";
import { historyStates } from "../src/memory.ts";
import type { ProcessDefinition, Simulation, StateData } from "../src/model.ts";
import { EventStatus } from "../src/model.ts";
import {
  dumpToDisk,
  initializeRun,
  loadHistory,
  runSimulation,
  shouldDump,
} from "../src/runner.ts";
import { serializeForDump } from "../src/serialize.ts";
import {
  continueEvent,
  createEvent,
  initializeSimulation,
  registerProcess,
  scheduleEvent,
} from "../src/simulation.ts";

Deno.test("shouldDump depends on local delta window only", () => {
  const sim = initializeSimulation();
  const window: HistoryWindow = {
    base: sim,
    deltas: [{ c: 1, e: [], es: [], et: [], s: [], st: [] }],
  };

  assertEquals(shouldDump(window, 2), false);
  window.deltas.push({ c: 2, e: [], es: [], et: [], s: [], st: [] });
  assertEquals(shouldDump(window, 2), true);
});

Deno.test("dumpToDisk writes a dump file", async () => {
  const dir = "runs/test/run-dumps-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();
  const window: HistoryWindow = {
    base: sim,
    deltas: [{ c: 1, e: [], es: [], et: [], s: [], st: [] }],
  };

  const runContext = await initializeRun(dir);
  await dumpToDisk(serializeForDump(window), 1, runContext);
  const stat = await Deno.stat(`${dir}/dumps/0-t1.json`);
  assert(stat.isFile);

  const raw = JSON.parse(await Deno.readTextFile(`${dir}/dumps/0-t1.json`));
  assertEquals(raw.deltas.length, 1);
  assertEquals(raw.base.currentTime, 0);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("initializeRun reuses existing manifest dump state", async () => {
  const dir = "runs/test/run-resume-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const manifest = {
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

  const context = await initializeRun(dir);
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
    () => initializeRun(dir, { interval: 3 }),
    SyntaxError,
  );

  await Deno.remove(dir, { recursive: true });
});

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
            ? [continueEvent(event, nextAt, { count })]
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

Deno.test("loadHistory returns empty array when run directory does not exist", async () => {
  const sim = initializeSimulation();
  const windows = await loadHistory(
    `runs/test/nonexistent-${crypto.randomUUID()}`,
    sim,
  );
  assertEquals(windows, []);
});

Deno.test("loadHistory returns empty array when no dump files exist", async () => {
  const dir = "runs/test/load-history-no-dumps";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // initializeRun creates run.json and the dumps/ dir, but no dump files yet.
  await initializeRun(dir);

  const sim = initializeSimulation();
  const windows = await loadHistory(dir, sim);
  assertEquals(windows, []);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHistory reconstructs states from dump files", async () => {
  const dir = "runs/test/load-history-single-dump";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // 3 events at t=1,2,3; interval=2.
  // Dump 0 (0-t2.json): base(ct=0) + deltas for t=1,2 → states [ct=0,1,2].
  // Dump 1 (1-t3.json): final flush, base(ct=2) + delta for t=3 → states [ct=2,3].
  // Stitched (base of dump 1 skipped: it is the last state of dump 0): [ct=0,1,2,3].
  const sim = buildCounterSim(3);
  await runSimulation(sim, { history: { directory: dir, interval: 2 } });

  const windows = await loadHistory(dir, sim);
  assertEquals(windows.length, 2);

  const states = historyStates(windows);

  assertEquals(states.length, 4);
  assertEquals(states[0].currentTime, 0);
  assertEquals(states[1].currentTime, 1);
  assertEquals(states[2].currentTime, 2);
  assertEquals(states[3].currentTime, 3);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHistory stitches multiple dump windows without duplicating boundary times", async () => {
  const dir = "runs/test/load-history-multi-dump";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // 6 events at t=1..6; interval=3 fires after t=3 and again after t=6.
  // Dump 0 (0-t3.json): base(ct=0) + deltas for t=1,2,3 → states [ct=0,1,2,3].
  // Dump 1 (1-t6.json): base(ct=3) + deltas for t=4,5,6 → states [ct=3,4,5,6].
  // When stitching, the base of dump 1 (the ct=3 boundary) is skipped
  // so ct=3 appears exactly once in the result (from dump 0).
  const sim = buildCounterSim(6);
  await runSimulation(sim, { history: { directory: dir, interval: 3 } });

  const states = historyStates(await loadHistory(dir, sim));

  assertEquals(states.length, 7);
  assertEquals(
    states.map((s) => s.currentTime),
    [0, 1, 2, 3, 4, 5, 6],
  );

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHistory sorts dump files by sequence number, not lexicographically", async () => {
  const dir = "runs/test/load-history-sort";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // 22 events at t=1..22; interval=2 produces 11 dump files (0-t2.json … 10-t22.json).
  // A lexicographic sort would place "10-t22.json" between "1-t4.json" and "2-t6.json",
  // corrupting the state sequence. The correct sort uses the integer sequence prefix.
  const sim = buildCounterSim(22);
  await runSimulation(sim, { history: { directory: dir, interval: 2 } });

  const states = historyStates(await loadHistory(dir, sim));

  // With correct sort the last state must be ct=22.
  // With lexicographic sort "10" sorts before "2", so the last processed window
  // would be "9-t20.json" and the last state would be ct=20 instead.
  assertEquals(states[states.length - 1].currentTime, 22);

  // All times must be monotonically non-decreasing.
  for (const [i, state] of states.entries()) {
    if (i === 0) continue;
    assert(
      state.currentTime >= states[i - 1].currentTime,
      `time went backward at index ${i}: ${
        states[i - 1].currentTime
      } → ${state.currentTime}`,
    );
  }

  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadHistory rethrows errors other than NotFound", async () => {
  // The catch block in loadHistory only suppresses Deno.errors.NotFound.
  // Any other error (e.g. NotADirectory when the dump path is a file) must be re-thrown.
  const dir = `runs/test/load-history-rethrow-${crypto.randomUUID()}`;
  await Deno.mkdir(dir, { recursive: true });

  // No run.json → readManifest returns {} → dumpDir defaults to "${dir}/dumps".
  // Create a plain FILE at that path so readDir throws a non-NotFound error.
  await Deno.writeTextFile(`${dir}/dumps`, "not a directory");

  const sim = initializeSimulation();
  await assertRejects(
    () => loadHistory(dir, sim),
  );

  await Deno.remove(dir, { recursive: true });
});

Deno.test("shouldDump returns false when deltas array is empty", () => {
  const sim = initializeSimulation();
  const window: HistoryWindow = {
    base: sim,
    deltas: [],
  };
  assertEquals(shouldDump(window, 1), false);
});

Deno.test("initializeRun merges metadata into the manifest", async () => {
  const dir = "runs/test/run-metadata-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const context = await initializeRun(dir, {
    metadata: { env: "ci", version: 42 },
  });

  assertEquals(context.manifest.metadata?.["env"], "ci");
  assertEquals(context.manifest.metadata?.["version"], 42);

  // Verify the metadata was persisted to disk
  const raw = JSON.parse(await Deno.readTextFile(context.manifestPath));
  assertEquals(raw.metadata?.["env"], "ci");
  assertEquals(raw.metadata?.["version"], 42);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("runSimulation returns a complete final state across compactions", async () => {
  // 250 events at t=1..250: the working state is compacted more than once along the way
  const sim = buildCounterSim(250);
  const { result, history } = await runSimulation(sim);

  assertEquals(history, undefined);
  assertEquals(result.currentTime, 250);
  assertEquals(Object.keys(result.timeline.events).length, 250);
  assert(
    Object.values(result.timeline.status).every((status) =>
      status === EventStatus.Finished
    ),
  );
  assertEquals(Object.keys(result.states).length, 250);

  // Each event is scheduled once and finished once: no transition is lost or duplicated
  assertEquals(result.timeline.transitions.length, 500);
  assertEquals(
    new Set(result.timeline.transitions.map((t) => `${t.id}:${t.status}`)).size,
    500,
  );
});

Deno.test("runSimulation leaves its input untouched", async () => {
  const sim = buildCounterSim(250);
  const before = JSON.stringify(sim);

  await runSimulation(sim);

  assertEquals(JSON.stringify(sim), before);
});

Deno.test("runSimulation returns the event it stopped before", async () => {
  // 250 events at t=1..250: the run is stopped after a compaction
  const sim = buildCounterSim(250);

  const paused = await runSimulation(sim, {
    until: (_sim, next) => next.scheduledAt > 120,
  });

  // Stopped by `until`: the event it returned `true` for, left `Scheduled`
  assertEquals(paused.result.currentTime, 120);
  assertEquals(paused.next?.scheduledAt, 121);
  assert(paused.next);
  assertEquals(
    paused.result.timeline.status[paused.next.id],
    EventStatus.Scheduled,
  );
  assertEquals(paused.result.timeline.events[paused.next.id], paused.next);

  // No event left: nothing is returned
  const resumed = await runSimulation(paused.result);

  assertEquals(resumed.result.currentTime, 250);
  assertEquals(resumed.next, undefined);
});

Deno.test("runSimulation keeps the same history in memory and on disk", async () => {
  const dir = "runs/test/history-memory-disk";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  // Windows of 60 events and compactions do not fall on the same events
  const memory = await runSimulation(buildCounterSim(250), {
    history: { interval: 60 },
  });
  const sim = buildCounterSim(250);
  const disk = await runSimulation(sim, {
    history: { directory: dir, interval: 60 },
  });

  assert(memory.history);
  assertEquals(memory.history.length, 5);
  assertEquals(disk.history, undefined);

  const fromMemory = historyStates(memory.history);
  const fromDisk = historyStates(await loadHistory(dir, sim));
  assertEquals(fromMemory.length, 251);
  assertEquals(fromDisk.length, 251);

  // Every state is complete: after k handled events, k events are finished, whatever was pruned along the way
  const finished = (state: Simulation) =>
    Object.values(state.timeline.status).filter((status) =>
      status === EventStatus.Finished
    ).length;
  for (const k of [0, 1, 59, 60, 61, 100, 101, 249, 250]) {
    assertEquals(fromMemory[k].currentTime, k);
    assertEquals(finished(fromMemory[k]), k);
    assertEquals(fromDisk[k].currentTime, k);
    assertEquals(finished(fromDisk[k]), k);
  }

  await Deno.remove(dir, { recursive: true });
});

Deno.test("runSimulation continues the history of a resumed run in the same directory", async () => {
  const dir = "runs/test/history-resume";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = buildCounterSim(250);
  const paused = await runSimulation(sim, {
    until: (_sim, next) => next.scheduledAt > 130,
    history: { directory: dir, interval: 60 },
  });
  assertEquals(paused.result.currentTime, 130);

  const resumed = await runSimulation(paused.result, {
    history: { directory: dir, interval: 60 },
  });
  assertEquals(resumed.result.currentTime, 250);

  const states = historyStates(await loadHistory(dir, sim));
  assertEquals(states.map((state) => state.currentTime), [
    ...Array(251).keys(),
  ]);
  assertEquals(
    states[250].timeline.transitions,
    resumed.result.timeline.transitions,
  );

  await Deno.remove(dir, { recursive: true });
});
