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

interface RunDumpMetadata {
  directory: string;
  interval: number;
  count: number;
  lastFile?: string;
}

interface RunManifest {
  runId: string;
  createdAt: string;
  updatedAt: string;
  runRoot: string;
  dump: RunDumpMetadata;
  metadata?: Record<string, unknown>;
}

/**
 * Context for managing simulation runs, including dump file management and run metadata persistence.
 * This is used to configure and track long-running simulations, allowing for periodic state dumps and resumption.
 */
export interface RunContext {
  /** Base directory for the simulation run, where metadata and dumps are stored. */
  runRoot: string;

  /** Directory for storing simulation dumps, relative to `runRoot`. */
  dumpDirectory: string;

  /** Path to the run manifest file (`run.json`) within `runRoot`. */
  manifestPath: string;

  /** In-memory representation of the run manifest, used for tracking run metadata and dump state. */
  manifest: RunManifest;
}

export interface DumpWriteResult {
  path: string;
  manifest: RunManifest;
}

const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_DUMP_DIR = "dumps";
const DEFAULT_DUMP_INTERVAL = 1000;

/**
 * Reads the run manifest from disk if it exists, or returns an empty object if not.
 * The manifest contains metadata about the simulation run, including dump configuration and run metadata.
 * This allows for resuming runs with existing metadata and dump state.
 */
async function readManifest(path: string): Promise<Partial<RunManifest>> {
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw) as Partial<RunManifest>;
  } catch (_err) {
    return {};
  }
}

/**
 * Determine if it's time to dump the current simulation state based on the configured interval and the number of deltas accumulated since the last dump.
 */
export function shouldDump(
  deltaEncoded: DeltaEncodedSimulation,
  interval: number,
): boolean {
  return deltaEncoded.deltas.length >= interval;
}

/**
 * Dump the current simulation state to disk and return dump file details.
 * Files are written to the run dump directory using the configured sequence/time pattern.
 * The file name uses a simple monotonic sequence and simulation time, e.g. `1-t100.json`.
 * This allows for easy identification of dump files and their corresponding simulation times.
 */
export async function dumpToDisk(
  serialized: string,
  currentTime: number,
  runContext: RunContext,
): Promise<DumpWriteResult> {
  const manifest = runContext.manifest;
  const fileName = `${manifest.dump.count}-t${currentTime}.json`;
  const dumpPath = `${runContext.dumpDirectory}/${fileName}`;

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
  runContext.manifest = nextManifest;

  await persistRunManifest(runContext.manifest, runContext.manifestPath);

  return {
    path: dumpPath,
    manifest: nextManifest,
  };
}

/**
 * Resolves the run context for a simulation run, including setting up directories and manifest state.
 * If a run manifest already exists, it will be read and used to populate the context; otherwise, a new manifest will be created.
 * This function ensures that the necessary directories exist and that the run manifest is initialized with the appropriate metadata.
 */
export async function resolveRunContext(
  options?: RunSimulationOptions,
): Promise<RunContext> {
  const runId = options?.runId ?? crypto.randomUUID();
  const runRoot = options?.runDirectory ?? `${DEFAULT_RUNS_DIR}/run-${runId}`;
  const manifestPath = `${runRoot}/run.json`;

  const previous = await readManifest(manifestPath);

  const dumpDirectory = previous.dump?.directory ??
    `${runRoot}/${DEFAULT_DUMP_DIR}`;
  const dumpInterval = options?.dumpInterval ?? previous.dump?.interval ??
    DEFAULT_DUMP_INTERVAL;

  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.mkdir(dumpDirectory, { recursive: true });

  const now = new Date().toISOString();
  const manifest: RunManifest = {
    runId: options?.runId ?? previous.runId ?? runId,
    runRoot,
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

  await persistRunManifest(manifest, manifestPath);

  return {
    runRoot,
    dumpDirectory,
    manifestPath,
    manifest,
  };
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
  const runContext = await resolveRunContext(options);
  const dumpInterval = runContext.manifest.dump.interval;

  const encoded: DeltaEncodedSimulation = {
    base: { ...init },
    deltas: [],
    current: { ...init },
  };
  const checkpoints: string[] = [];
  const result = {
    current: init,
  };

  const start = performance.now();
  while (true) {
    const [next, continuation] = run(result.current);
    if (!continuation) break;
    result.current = next;

    encoded.deltas.push(createDelta(encoded.current, result.current));
    encoded.current = result.current;

    if (options?.rate) await delay(options.rate);
    if (options && shouldTerminate(result.current, options)) break;

    if (shouldDump(encoded, dumpInterval)) {
      const checkpoint = await dumpToDisk(
        serializeSimulation(encoded),
        encoded.current.currentTime,
        runContext,
      );
      checkpoints.push(checkpoint.path);
      const compacted = pruneWorkingState(result.current);
      encoded.base = compacted;
      encoded.deltas = [];
      encoded.current = compacted;
      result.current = compacted;
    }
  }

  const stop = performance.now();
  if (checkpoints.length > 0) {
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
