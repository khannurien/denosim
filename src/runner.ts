import { DeltaEncodedSimulation } from "./memory.ts";
import { RunSimulationOptions } from "./model.ts";
import { serializeSimulation } from "./serialize.ts";

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
  deltaEncoded: DeltaEncodedSimulation,
  runContext: RunContext,
): Promise<void> {
  const fileName =
    `${runContext.manifest.dump.count}-t${deltaEncoded.current.currentTime}.json`;
  const dumpPath = `${runContext.dumpDirectory}/${fileName}`;

  // Persist all current simulation history
  const serialized = serializeSimulation(deltaEncoded);
  // FIXME: Do not await, write asynchronously
  await Deno.writeTextFile(dumpPath, serialized);

  runContext.manifest.dump.count += 1;
  runContext.manifest.dump.lastFile = fileName;

  await persistRunManifest(runContext);
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

  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    runRoot,
    dumpDirectory,
    manifestPath,
    manifest,
  };
}

/**
 * Persists the run manifest to disk, updating the `updatedAt` timestamp.
 * This should be called whenever the run manifest is updated, such as after creating a new dump or updating run metadata.
 * By keeping the manifest up-to-date on disk, we ensure that the run state can be accurately resumed in case of interruption.
 */
export async function persistRunManifest(
  runContext: RunContext,
): Promise<void> {
  runContext.manifest.updatedAt = new Date().toISOString();
  await Deno.writeTextFile(
    runContext.manifestPath,
    JSON.stringify(runContext.manifest, null, 2),
  );
}
