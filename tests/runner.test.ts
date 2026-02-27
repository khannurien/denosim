import { assert, assertEquals } from "@std/assert";

import { DeltaEncodedSimulation } from "../src/memory.ts";
import { EventState, ProcessDefinition, StateData } from "../src/model.ts";
import {
  dumpToDisk,
  reconstructFullCurrent,
  resolveRunContext,
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

  const runContext = await resolveRunContext({ runDirectory: dir });
  await dumpToDisk(serializeSimulation(deltaEncoded), 1, runContext);
  const stat = await Deno.stat(`${dir}/dumps/0-t1.json`);
  assert(stat.isFile);

  const raw = JSON.parse(await Deno.readTextFile(`${dir}/dumps/0-t1.json`));
  assertEquals(raw.deltas.length, 1);
  assertEquals(raw.base.currentTime, 0);
  assertEquals(raw.current.currentTime, 1);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("resolveRunContext reuses existing manifest dump state", async () => {
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

  const context = await resolveRunContext({ runDirectory: dir });
  assertEquals(context.dumpDirectory, `${dir}/custom-dumps`);
  assertEquals(context.manifest.dump.interval, 7);
  assertEquals(context.manifest.dump.count, 42);
  assertEquals(context.manifest.dump.lastFile, "41-t99.json");
  assertEquals(context.manifest.metadata?.source, "test");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("resolveRunContext tolerates invalid run.json and recreates defaults", async () => {
  const dir = "runs/test/run-invalid-manifest-test";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/run.json`, "{ not valid json");

  const context = await resolveRunContext({
    runDirectory: dir,
    dumpInterval: 3,
  });
  assertEquals(context.runRoot, dir);
  assertEquals(context.dumpDirectory, `${dir}/dumps`);
  assertEquals(context.manifest.dump.interval, 3);
  assertEquals(context.manifest.dump.count, 0);

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

  sim.registry = registerProcess(sim, simpleProcess);

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
  tailSim.registry = sim.registry;
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
