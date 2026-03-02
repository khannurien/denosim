import {
  createDelta,
  DeltaEncodedSimulation,
  pruneWorkingState,
} from "./memory.ts";
import {
  Event,
  EventID,
  EventState,
  RunSimulationOptions,
  Simulation,
  SimulationResult,
} from "./model.ts";
import { deserializeSimulation, serializeSimulation } from "./serialize.ts";
import { run, shouldTerminate } from "./simulation.ts";

/**
 * Dump configuration and mutable state for a simulation run.
 * Persisted as part of `RunManifest` so that dump sequencing survives process restarts.
 */
interface RunDumpMetadata {
  /** Directory where dump files are written */
  directory: string;

  /** Number of deltas to accumulate between dumps; controls the granularity vs. disk-write tradeoff */
  interval: number;

  /** Monotonically increasing count of dumps written so far; used as the numeric prefix in dump file names */
  count: number;

  /** File name (not full path) of the most recently written dump, if any */
  lastFile?: string;
}

/**
 * Persisted representation of a simulation run, written to `run.json` in the run's root directory.
 * Combines run identity, timestamps, dump state, and optional user metadata in a single document.
 * Written on initialization and after every dump, so it always reflects the latest run state and allows interrupted runs to be resumed or inspected after the fact.
 */
interface RunManifest {
  /** Unique identifier for this run; stable across restarts of the same run */
  runId: string;

  /** ISO 8601 timestamp of when this run was first initialized; never updated after creation */
  createdAt: string;

  /** ISO 8601 timestamp of the most recent manifest write; updated on every dump */
  updatedAt: string;

  /** Root directory for this run */
  runRoot: string;

  /** Dump configuration and progress state */
  dump: RunDumpMetadata;

  /** Optional user-supplied metadata, merged from `RunSimulationOptions.runMetadata` at run start */
  metadata?: Record<string, unknown>;
}

/**
 * Context for managing simulation runs, including dump file management and run metadata persistence.
 */
export interface RunContext {
  /** Path to run.json on disk */
  manifestPath: string;

  /** In-memory manifest */
  manifest: RunManifest;
}

/**
 * Result of a single `dumpToDisk` call: the path of the written checkpoint file and the updated manifest reflecting the incremented dump count and latest file name.
 */
export interface DumpWriteResult {
  /** Absolute or relative path to the checkpoint file just written */
  path: string;

  /** Updated manifest after recording this dump; should be persisted to the `RunContext` */
  manifest: RunManifest;
}

const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_DUMP_DIR = "dumps";
const DEFAULT_DUMP_INTERVAL = 1000;

/**
 * Reads the run manifest from disk if it exists.
 * Re-throws any other error (e.g. JSON parse errors, permission errors) in case of corrupted or unreadable manifest.
 * Returns an empty object if an existing manifest is not found.
 */
async function readManifest(path: string): Promise<Partial<RunManifest>> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Partial<RunManifest>;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
}

/**
 * Merges a previous (possibly partial) manifest with options and computed defaults into a complete RunManifest.
 */
function buildManifest(
  previous: Partial<RunManifest>,
  options: RunSimulationOptions | undefined,
  defaults: { runId: string; runRoot: string },
): RunManifest {
  const now = new Date().toISOString();
  const dumpDirectory = previous.dump?.directory ??
    `${defaults.runRoot}/${DEFAULT_DUMP_DIR}`;
  const dumpInterval = options?.dumpInterval ?? previous.dump?.interval ??
    DEFAULT_DUMP_INTERVAL;

  return {
    runId: previous.runId ?? defaults.runId,
    runRoot: defaults.runRoot,
    createdAt: previous.createdAt ?? now,
    updatedAt: now,
    dump: {
      directory: dumpDirectory,
      interval: dumpInterval,
      count: previous.dump?.count ?? 0,
      lastFile: previous.dump?.lastFile,
    },
    metadata: {
      ...(previous.metadata ?? {}),
      ...(options?.runMetadata ?? {}),
    },
  };
}

/**
 * Determines if it's time to dump the current simulation state based on the configured interval and the number of deltas accumulated since the last dump.
 */
export function shouldDump(
  deltaEncoded: DeltaEncodedSimulation,
  interval: number,
): boolean {
  return deltaEncoded.deltas.length >= interval;
}

/**
 * Dumps the current simulation state to disk and return dump file details.
 * Files are written to the run dump directory using the configured sequence/time pattern.
 * The file name uses a simple monotonic sequence and simulation time, e.g. `1-t100.json`.
 * Returns the updated manifest.
 */
export async function dumpToDisk(
  serialized: string,
  currentTime: number,
  context: RunContext,
): Promise<DumpWriteResult> {
  const manifest = context.manifest;
  const fileName = `${manifest.dump.count}-t${currentTime}.json`;
  const dumpPath = `${manifest.dump.directory}/${fileName}`;

  // FIXME: Do not await, write asynchronously
  await Deno.writeTextFile(dumpPath, serialized);

  const nextManifest: RunManifest = {
    ...manifest,
    dump: {
      ...manifest.dump,
      count: manifest.dump.count + 1,
      lastFile: fileName,
    },
  };

  await persistRunManifest(nextManifest, context.manifestPath);

  return {
    path: dumpPath,
    manifest: nextManifest,
  };
}

/**
 * Initializes a simulation run: computes paths, reads any previous manifest from disk, builds the merged manifest, creates necessary directories, and writes the manifest.
 * Returns a `RunContext` for use in the main simulation loop.
 */
export async function initializeRun(
  options?: RunSimulationOptions,
): Promise<RunContext> {
  const runId = options?.runId ?? crypto.randomUUID();
  const runRoot = options?.runDirectory ?? `${DEFAULT_RUNS_DIR}/run-${runId}`;
  const manifestPath = `${runRoot}/run.json`;

  // Read previous manifest from disk if it exists
  const previous = await readManifest(manifestPath);

  const manifest = buildManifest(previous, options, { runId, runRoot });

  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.mkdir(manifest.dump.directory, { recursive: true });

  await persistRunManifest(manifest, manifestPath);

  return { manifestPath, manifest };
}

/**
 * Persists the run manifest to disk.
 * This should be called whenever the run manifest is updated, such as after creating a new dump or updating run metadata.
 * By keeping the manifest up-to-date on disk, we ensure that the run state can be accurately resumed in case of interruption.
 */
export async function persistRunManifest(
  manifest: RunManifest,
  manifestPath: string,
): Promise<void> {
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Runs the discrete-event simulation until:
 * - either no more events remain to process;
 * - or the simulation time reaches at least the specified `until` time;
 * - or the simulation reaches a point where the specified `until` event is processed.
 * The simulation processes events in chronological order (earliest first).
 * Playback speed can be adjusted by passing a simulation rate (expressed in Hz).
 * Returns the final simulation state along with statistics about the run.
 */
export async function runSimulation(
  init: Simulation,
  options?: RunSimulationOptions,
): Promise<SimulationResult<Simulation>> {
  const { result, stats } = await runSimulationWithDeltas(init, options);

  return {
    result: result.current,
    stats,
  };
}

/**
 * Runs the simulation and exposes the delta/checkpoint representation.
 * Layers on memory management: delta accumulation, periodic checkpoint dumps, state pruning, and final reconstruction from disk when checkpoints have been written.
 */
export async function runSimulationWithDeltas(
  init: Simulation,
  options?: RunSimulationOptions,
): Promise<SimulationResult<DeltaEncodedSimulation>> {
  const context = await initializeRun(options);

  const encoded: DeltaEncodedSimulation = {
    base: { ...init },
    deltas: [],
    current: { ...init },
  };
  const checkpoints: string[] = [];

  // Main simulation loop
  const start = performance.now();
  while (true) {
    const [next, continuation] = run(encoded.current);
    if (!continuation) break;

    // Record the diff from the previous state to the next and advance the current pointer
    encoded.deltas.push(createDelta(encoded.current, next));
    encoded.current = next;

    if (options?.rate) await delay(options.rate);
    if (options && shouldTerminate(encoded.current, options)) break;

    if (shouldDump(encoded, context.manifest.dump.interval)) {
      // Flush accumulated deltas to disk and record the checkpoint path
      const dump = await dumpToDisk(
        serializeSimulation(encoded),
        encoded.current.currentTime,
        context,
      );
      checkpoints.push(dump.path);
      context.manifest = dump.manifest;

      // Compact in-memory state: history is now safely on disk, we can drop it
      // Make the pruned state the new base for future deltas
      const compacted = pruneWorkingState(encoded.current);
      encoded.base = compacted;
      encoded.deltas = [];
      encoded.current = compacted;
    }
  }

  const stop = performance.now();
  if (checkpoints.length > 0) {
    // Produce a full-history view of the run
    // Merge all checkpoint files with the in-memory tail
    const current = await reconstructFullCurrent(checkpoints, encoded.current);
    encoded.base = current;
    encoded.deltas = [];
    encoded.current = current;
  }

  return {
    result: encoded,
    stats: {
      end: encoded.current.currentTime,
      duration: stop - start,
    },
  };
}

/**
 * Helper function to introduce a wall-clock delay based on desired simulation rate (in Hz).
 * If rate is not provided, executes immediately.
 * Otherwise, computes delay in milliseconds and times out accordingly.
 */
function delay(rate: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, rate > 0 ? 1000 / rate : 0)
  );
}

/**
 * Reconstructs a full current state from checkpoint files and an in-memory tail.
 * This restores replay-complete state for run outputs while allowing in-run pruning.
 */
export async function reconstructFullCurrent(
  checkpoints: string[],
  tail: Simulation,
): Promise<Simulation> {
  const snapshots = await Promise.all(
    checkpoints.map(async (checkpoint) => {
      const states = deserializeSimulation(
        await Deno.readTextFile(checkpoint),
        tail.registry,
      );
      return states[states.length - 1];
    }),
  );

  if (snapshots.length === 0) {
    return tail;
  }

  const [first, ...rest] = snapshots;
  const full = rest.reduce(
    (acc, current) => mergeReplayState(acc, current),
    first,
  );

  return mergeReplayState(full, tail);
}

/**
 * Merges two simulation states for full-history reconstruction after a run with checkpoints.
 * Used to fold checkpoint snapshots together with the in-memory tail into a single replay-complete simulation state.
 * Events and statuses from `current` take precedence over `previous`; transitions are concatenated in chronological order.
 */
function mergeReplayState(
  previous: Simulation,
  current: Simulation,
): Simulation {
  const eventsById: Record<string, Event> = {
    ...previous.timeline.events,
  };

  for (const [id, event] of Object.entries(current.timeline.events)) {
    eventsById[id] = event;
  }

  const statusById: Record<EventID, EventState> = {
    ...previous.timeline.status,
  };

  for (const [id, status] of Object.entries(current.timeline.status)) {
    statusById[id] = status;
  }

  const transitions = [
    ...previous.timeline.transitions,
    ...current.timeline.transitions,
  ];

  return {
    ...current,
    timeline: {
      ...current.timeline,
      events: eventsById,
      status: statusById,
      transitions,
    },
    state: {
      ...previous.state,
      ...current.state,
    },
  };
}
