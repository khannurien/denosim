import type { HistoryWindow } from "./memory.ts";
import {
  absorbWorkingState,
  createDelta,
  pruneWorkingState,
} from "./memory.ts";
import type {
  Event,
  Simulation,
  SimulationRegistries,
  StoreItemMap,
  Timestamp,
} from "./model.ts";
import { EventStatus } from "./model.ts";
import { deserializeDump, serializeForDump } from "./serialize.ts";
import { buildHeap, heapPush } from "./heap.ts";
import { advance, nextEvent } from "./simulation.ts";

/**
 * Statistics about a simulation run.
 * Currently tracks only end timestamp and simulation duration, but could be extended with:
 * - Average process latency
 * - Other performance metrics
 */
export interface SimulationStats {
  /** Simulation time the simulation ended at */
  end: Timestamp;

  /** Real-world time (in milliseconds) the simulation took to complete */
  duration: number;
}

/**
 * Return value of a simulation run.
 * Bundles the final simulation along with run statistics.
 */
export interface SimulationResult<S extends StoreItemMap = StoreItemMap> {
  /** Final simulation state: complete, with every event since the state the run started from */
  result: Simulation<S>;

  /** Statistics for the completed run */
  stats: SimulationStats;

  /** Event the run stopped before, when `until` or `signal` ended it: left `Scheduled`, handled first if the result is run again; unset when no event was left */
  next?: Event;

  /** History windows of the run, in order; only set when `history` is asked without a `directory` */
  history?: HistoryWindow<S>[];
}

/**
 * Object used to keep the history of a run: every intermediate state, as a sequence of windows.
 * Windows are kept in memory and returned, unless a `directory` is given: they are then written there, one dump per window.
 */
export interface HistoryOptions {
  /**
   * Directory where the history is written. If omitted, nothing touches the disk.
   * If `run.json` exists in this directory, it is merged as run defaults, and dumps are added after the existing ones.
   */
  directory?: string;

  /** Number of handled events per window; defaults to `1000` */
  interval?: number;

  /** Optional metadata merged into `run.json` for this run; only used with a `directory` */
  metadata?: Record<string, unknown>;
}

/**
 * Object used to configure a simulation run.
 * Allows setting a condition to stop the simulation on.
 * Allows setting the rate of simulation to map wall-clock speed to the virtual passing of time.
 * Allows keeping the history of the run, in memory or on disk.
 */
export interface RunSimulationOptions<S extends StoreItemMap = StoreItemMap> {
  /**
   * Stop condition, checked before each event is handled: `next` is the event about to be handled.
   * When it returns `true` the simulation stops and `next` stays `Scheduled`; running the result again resumes from there.
   * Must have no side effect: with a `rate`, it is checked again after the wait. If it then stops the run, the clock is at `next.scheduledAt`.
   */
  until?: (sim: Simulation<S>, next: Event) => boolean;

  /** Simulation speed, in simulation time units per wall-clock second */
  rate?: number;

  /**
   * Stops the run from outside, including during the wait before an event: the event stays `Scheduled`.
   * Only seen while the run waits: without a `rate`, the loop never yields.
   */
  signal?: AbortSignal;

  /** Keeps the history of the run; if omitted, only the final state is returned */
  history?: HistoryOptions;
}

/**
 * Dump configuration and mutable state for a simulation run.
 * Persisted as part of `RunManifest` so that dump sequencing survives process restarts.
 */
interface RunDumpMetadata {
  /** Directory where dump files are written */
  directory: string;

  /** Number of deltas per dump; controls the granularity vs. disk-write tradeoff */
  interval: number;

  /** Monotonically increasing count of dumps written so far; used as the numeric prefix in dump file names */
  count: number;

  /** File name (not full path) of the most recently written dump, if any */
  lastFile?: string;
}

/**
 * Persisted representation of a simulation run, written to `run.json` in the run's root directory.
 * Combines timestamps, dump state, and optional user metadata in a single document.
 * Written on initialization and after every dump, so it always reflects the latest run state and allows interrupted runs to be resumed or inspected after the fact.
 */
interface RunManifest {
  /** ISO 8601 timestamp of when this run was first initialized; never updated after creation */
  createdAt: string;

  /** ISO 8601 timestamp of the most recent manifest write; updated on every dump */
  updatedAt: string;

  /** Root directory for this run */
  runRoot: string;

  /** Dump configuration and progress state */
  dump: RunDumpMetadata;

  /** Optional user-supplied metadata, merged from `HistoryOptions.metadata` at run start */
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
 * Result of a single `dumpToDisk` call: the path of the written dump file and the updated manifest reflecting the incremented dump count and latest file name.
 */
export interface DumpWriteResult {
  /** Absolute or relative path to the dump file just written */
  path: string;

  /** Updated manifest after recording this dump; should be persisted to the `RunContext` */
  manifest: RunManifest;
}

const DEFAULT_DUMP_DIR = "dumps";
const DEFAULT_DUMP_INTERVAL = 1000;

/**
 * Number of handled events between two compactions of the working state.
 * Handling an event copies the timeline: its cost grows with the number of events held, whether the history is kept or not.
 * FIXME: Only finished events are dropped: with N events scheduled up front, handling one still costs O(N)
 */
const COMPACTION_INTERVAL = 100;

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
  options: HistoryOptions | undefined,
  runRoot: string,
): RunManifest {
  const now = new Date().toISOString();
  const dumpDirectory = previous.dump?.directory ??
    `${runRoot}/${DEFAULT_DUMP_DIR}`;
  const dumpInterval = options?.interval ?? previous.dump?.interval ??
    DEFAULT_DUMP_INTERVAL;

  return {
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
      ...(options?.metadata ?? {}),
    },
  };
}

/**
 * Determines if it's time to close the current history window based on the configured interval and the number of deltas accumulated since the last one.
 */
export function shouldDump(
  window: HistoryWindow,
  interval: number,
): boolean {
  return window.deltas.length >= interval;
}

/**
 * Dumps a serialized history window to disk and return dump file details.
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
 * Initializes a simulation run in `directory`: computes paths, reads any previous manifest from disk, builds the merged manifest, creates necessary directories, and writes the manifest.
 * Returns a `RunContext` for use in the main simulation loop.
 */
export async function initializeRun(
  directory: string,
  options?: HistoryOptions,
): Promise<RunContext> {
  const manifestPath = `${directory}/run.json`;

  // Read previous manifest from disk if it exists
  const previous = await readManifest(manifestPath);

  const manifest = buildManifest(previous, options, directory);

  await Deno.mkdir(directory, { recursive: true });
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
 * - or `until` returns `true` for the next event to process;
 * - or `signal` is aborted.
 * The simulation processes events in chronological order (earliest first).
 * Playback speed can be adjusted by passing a simulation rate (in simulation time units per wall-clock second).
 * `init` is left untouched: it can be run again, e.g. to branch out from it.
 * Returns the final simulation state along with statistics about the run, the event it stopped before if `until` or `signal` ended it, and its history if asked.
 *
 * Layers on memory management: the working state is compacted every `COMPACTION_INTERVAL` handled events, and the complete final state is put back together at the end.
 * Nothing touches the disk unless `history.directory` is given.
 */
export async function runSimulation<S extends StoreItemMap>(
  init: Simulation<S>,
  options?: RunSimulationOptions<S>,
): Promise<SimulationResult<S>> {
  const history = options?.history;
  const context = history?.directory !== undefined
    ? await initializeRun(history.directory, history)
    : undefined;
  const interval = context?.manifest.dump.interval ?? history?.interval ??
    DEFAULT_DUMP_INTERVAL;

  // Complete state, accumulated at each compaction; starts with everything `init` holds
  const full: Pick<Simulation, "timeline" | "states"> = {
    timeline: { events: {}, status: {}, transitions: [] },
    states: {},
  };
  absorbWorkingState(full, init, 0);

  // Working state since the last compaction: `current` is the state the loop advances, finished events are pruned from it at each compaction
  // Every transition of `base` is already held by `full`
  const working: HistoryWindow<S> & { current: Simulation<S> } = {
    base: init,
    deltas: [],
    current: init,
  };

  // Current history window, and the windows kept in memory
  const window: HistoryWindow<S> = { base: init, deltas: [] };
  const windows: HistoryWindow<S>[] = [];

  // Closes the current history window: writes it to disk, or keeps it in memory
  const closeWindow = async () => {
    if (context) {
      const dump = await dumpToDisk(
        serializeForDump(window),
        working.current.currentTime,
        context,
      );
      context.manifest = dump.manifest;
    } else {
      windows.push({ base: window.base, deltas: window.deltas });
    }

    window.base = working.current;
    window.deltas = [];
  };

  // Initialize heap from starting simulation state
  const heap = buildHeap(init);

  // Main simulation loop
  const start = performance.now();
  while (true) {
    const next = nextEvent(working.current, heap);
    if (!next) break;

    if (options?.signal?.aborted) break;
    if (options?.until?.(working.current, next)) break;

    if (options?.rate) {
      const wait = (next.scheduledAt - working.current.currentTime) * 1000 /
        options.rate;
      if (wait > 0) {
        const waited = await delay(wait, options.signal);

        // The run may have been stopped during the wait (e.g. a pause asked from outside the loop)
        if (
          options.signal?.aborted || options.until?.(working.current, next)
        ) {
          // The clock stops where the wait did: running the result again waits for what is left
          working.current = {
            ...working.current,
            currentTime: Math.min(
              next.scheduledAt,
              working.current.currentTime + waited * options.rate / 1000,
            ),
          };
          break;
        }
      }
    }

    const [after] = advance(working.current, heap);

    // Record the diff from the previous state to the next and advance the current pointer
    const delta = createDelta(working.current, after);
    working.deltas.push(delta);
    working.current = after;

    // Push newly scheduled events onto the heap
    // delta.e contains events added this step; Waiting events are excluded (not yet schedulable)
    for (const op of delta.e) {
      if (after.timeline.status[op.key] === EventStatus.Scheduled) {
        const event = after.timeline.events[op.key];
        heapPush(heap, {
          scheduledAt: event.scheduledAt,
          priority: event.priority,
          id: op.key,
        });
      }
    }

    if (working.deltas.length >= COMPACTION_INTERVAL) {
      // Compact the working state: what it holds is now safely in `full`, we can drop the finished events
      // Make the pruned state the new base for future deltas
      absorbWorkingState(
        full,
        working.current,
        working.base.timeline.transitions.length,
      );
      const compacted = pruneWorkingState(working.current);
      working.base = compacted;
      working.deltas = [];
      working.current = compacted;

      // Rebuild heap from pruned state: finished events are gone, stale entries discarded
      const fresh = buildHeap(compacted);
      heap.entries = fresh.entries;
      heap.seq = fresh.seq;
    }

    if (history) {
      window.deltas.push(delta);
      if (shouldDump(window, interval)) await closeWindow();
    }
  }

  // Close the last window, unless the loop exited exactly on a window boundary
  if (history && window.deltas.length > 0) await closeWindow();

  const stop = performance.now();

  // Event the loop exited before, if `until` or `signal` ended the run
  const pending = nextEvent(working.current, heap);

  // Put the complete final state back together
  absorbWorkingState(
    full,
    working.current,
    working.base.timeline.transitions.length,
  );
  const result: Simulation<S> = { ...working.current, ...full };

  return {
    result,
    stats: {
      end: result.currentTime,
      duration: stop - start,
    },
    ...(pending && { next: pending }),
    ...(history && !context && { history: windows }),
  };
}

/**
 * Helper function to introduce a wall-clock delay, in milliseconds; cut short when `signal` is aborted.
 * Returns the time actually waited.
 */
function delay(ms: number, signal?: AbortSignal): Promise<number> {
  const start = performance.now();

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve(performance.now() - start);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/**
 * Loads the history windows written to `directory` by previous `runSimulation` runs, in order.
 * Each dump file is a self-contained window. Pass the result to `historyStates` to reconstruct the intermediate states, as with the windows of a run that kept its history in memory.
 * Registries that are initialized in user code must be passed to the function.
 * `S` types the stores of the windows, when given (e.g. `loadHistory<Stores>(directory, sim)`): the dumps are trusted to hold them.
 * Returns an empty array if the directory or its dumps do not exist.
 */
export async function loadHistory<S extends StoreItemMap = StoreItemMap>(
  directory: string,
  registries: SimulationRegistries,
): Promise<HistoryWindow<S>[]> {
  // Read the manifest to find the dump directory
  // May differ from the default if the run was initialized with a custom path
  const manifestPath = `${directory}/run.json`;
  const manifest = await readManifest(manifestPath);
  const dumpDir = manifest.dump?.directory ??
    `${directory}/${DEFAULT_DUMP_DIR}`;

  // Collect all dump files
  const dumps: string[] = [];
  try {
    for await (const entry of Deno.readDir(dumpDir)) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        dumps.push(`${dumpDir}/${entry.name}`);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }

  // Sort by the monotonic sequence prefix (e.g. "2-t400.json" -> 2)
  // parseInt stops at the first non-digit character, so no explicit split needed
  dumps.sort((a, b) => {
    const nameA = a.split("/").pop()!;
    const nameB = b.split("/").pop()!;
    return parseInt(nameA, 10) - parseInt(nameB, 10);
  });

  const windows: HistoryWindow<S>[] = [];
  for (const file of dumps) {
    windows.push(deserializeDump<S>(await Deno.readTextFile(file), registries));
  }

  return windows;
}
