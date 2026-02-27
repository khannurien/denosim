/**
 * Core simulation container that maintains:
 * - The current virtual time of the simulation
 * - The simulation timeline (events along with their state transitions)
 * - A process definition registry for all processes available in the simulation
 * - The current state of all running processes
 * - All resource stores registered for use in process handlers
 */
export interface Simulation<
  R extends ProcessRegistry = ProcessRegistry,
  S extends StoreRegistry = StoreRegistry,
> {
  /**
   * The current virtual time in the simulation.
   * Represents the timestamp up to which the simulation has processed.
   * Measured in arbitrary time units (could be steps, seconds, etc.).
   */
  currentTime: Timestamp;

  /**
   * Full lifecycle record for every event in the simulation.
   * Combines immutable event definitions with the append-only transition log and derived indexes that make common queries (current status, pending events) O(1).
   */
  timeline: Timeline;

  /**
   * Registry of all process definitions available in the simulation.
   * Maps process names to their definitions.
   * Allows dynamic process registration and lookup.
   * Includes a default `none` process for events without associated processes.
   */
  registry: R;

  /**
   * Current simulation state of all running processes.
   * Maps processes' event ID to their current state data.
   */
  state: Record<EventID, ProcessState>;

  /**
   * Current state of all stores in the simulation.
   * Stores may be used for inter-process communications (message passing, data sharing, synchronization, etc.).
   */
  stores: StoreDefinitions<S>;
}

/**
 * Parallel data structures that together describe the full lifecycle of every event:
 * - `events`: immutable event definitions, keyed by ID (what the event is)
 * - `transitions`: append-only log of every state change (when and how it progressed)
 * - `status`: denormalized current-state index derived from `transitions` (fast O(1) lookup)
 *
 * `transitions` is the source of truth for event progression; `status` is a derived cache.
 * Together they bound each event's lifetime: the first transition records when it was scheduled (or placed in waiting), and subsequent transitions record state changes through to `Finished`.
 *
 * `transitions` is append-only and grows with the simulation; old entries are pruned at checkpoint boundaries via `pruneWorkingState` while the full history remains on disk.
 */
export interface Timeline {
  /** Immutable event definitions keyed by event ID */
  events: Record<EventID, Event>;

  /** Always reflects the most recent transition for each event ID */
  status: Record<EventID, EventState>;

  /** Append-only source of truth for event progression */
  transitions: EventTransition[];
}

/**
 * Lifecycle states for events within the simulation.
 * Events progress through states with possible blocking at Waiting.
 */
export enum EventState {
  /**
   * Event has been scheduled for future processing.
   * Will be executed when simulation time reaches `scheduledAt`.
   */
  Scheduled = "Scheduled",

  /**
   * Event is blocked waiting for external conditions.
   * Used by store operations and synchronization primitives.
   * Events remain in this state until unblocked by another process.
   */
  Waiting = "Waiting",

  /**
   * Final state indicating the event has been fully processed.
   * Events in this state remain in the system for historical tracking.
   */
  Finished = "Finished",
}

/** Append-only event lifecycle transition entry */
export interface EventTransition {
  /** Event identifier affected by this transition */
  id: EventID;

  /** Lifecycle state reached by the event */
  state: EventState;

  /** Simulation timestamp when the transition occurred */
  at: Timestamp;
}

/**
 * Represents a discrete event in the simulation system.
 * Events can be tied to processes, which define their behavior.
 * Event definitions are immutable; lifecycle progression is represented through `EventTransition` entries.
 * Events can have parent-child relationships in the context of their process.
 * TODO: They can be created with a `waiting` attribute that...
 * Events scheduled at the same timestamp will be selected based on their priority (the lower the value, the higher the priority). In case of a tie, the scheduler dequeues events in a LIFO fashion.
 */
export interface Event<T extends StateData = StateData> {
  /** Unique identifier for the event */
  id: EventID;

  /** Optional parent event ID; defines a graph of events across processes */
  parent?: EventID;

  /** TODO: */
  waiting?: boolean;

  /**
   * Optional event priority for scheduling; lower value yields higher priority (cf. UNIX `nice`).
   * Defaults to `0`.
   */
  priority: number;

  /**
   * When the event should be processed.
   * Simulation time will jump directly to this value when processed.
   */
  scheduledAt: Timestamp;

  /**
   * Type of process to execute when event is handled.
   * Defaults to `none`, which calls a no-op process.
   * Optional data can be used to initialize the process state.
   */
  process: ProcessCall<T>;
}

/**
 * Shared data structure used for coordinating processes.
 * Stores are used through `get` and `put` primitives that work in a LIFO fashion.
 * Used for inter-process synchronization, producer-consumer patterns, resource sharing, etc.
 */
export interface Store<
  T extends StateData = StateData,
  K extends StoreID = StoreID,
> {
  /** Unique identifier for this store */
  id: K;

  /** Maximum items the store can hold before `put` operations block. Defaults to `1`. */
  capacity: number;

  /**
   * Controls whether the store enables synchronous (blocking) or asynchronous coordination.
   * Defaults to `true`.
   */
  blocking: boolean;

  /** Optional discipline for managing the order of events in the store's queues. Defaults to LIFO. */
  discipline: QueueDiscipline;

  /** Items currently stored by non-blocking `put` operations and awaiting consumption */
  buffer: Event<T>[];

  /** Processes blocked waiting to get items */
  getRequests: Event<T>[];

  /** Processes blocked waiting to put items */
  putRequests: Event<T>[];
}

/**
 * Returned by `get` and `put` store operations to indicate the outcome in terms of continuation and possible resume events.
 */
export interface StoreResult<T extends StateData = StateData> {
  /**
   * Continuation event for the calling process.
   * Must be scheduled by the process handler of the calling event.
   */
  step: Event<T>;

  /**
   * Resume event for the blocked process, if any.
   * Used to resume a process that was blocked by a store operation when the conditions for resumption are met.
   * This is relevant for blocking stores where processes can be paused until certain conditions are satisfied (e.g., an item is put into the store or space becomes available).
   * In non-blocking scenarios, this may be `undefined` since the process can continue immediately without waiting for store conditions.
   */
  resume?: Event<T>[];

  /**
   * TODO:
   */
  finish?: Event[];
}

/** Timestamp for simulation clock */
export type Timestamp = number;

/** Unique, random identifier for an event */
export type EventID = string;

/** Unique, random identifier for a store */
export type StoreID = string;

/** Unique, user-defined identifier for a process */
export type ProcessType = string;

/** User-defined identifier for a step within a process. Unique at process level */
export type StepType = string;

/** Represents any data that can be stored in the simulation state */
export type StateData = Record<string, unknown>;

/** Maps store IDs to their payload state data types */
export type StoreRegistry = Record<StoreID, StateData>;

/** Dynamically maps store IDs to their corresponding store definitions */
export type StoreDefinitions<R extends StoreRegistry> = {
  [K in keyof R]: Store<R[K], Extract<K, StoreID>>;
};

/**
 * Used to specify and narrow the type of input state data for a process step.
 * Associates a process step to the type of the state data that is passed to the process step handler.
 */
export type StepStateMap = Record<StepType, StateData>;

/** Dynamically maps process steps to their corresponding handlers */
export type StepsDefinition<M extends StepStateMap> = {
  [K in keyof M]: ProcessHandler<M, K>;
};

/**
 * Map process types to their definitions.
 * Used for process lookup and execution in the simulation.
 */
export type ProcessRegistry = Record<
  ProcessType,
  ProcessDefinition<StepStateMap>
>;

/**
 * Defines a process with a unique type and its state machine behavior.
 * Processes progress through steps, each with specific input/output state types.
 * Used to model workflows, state machines, and temporal patterns in the simulation.
 */
export interface ProcessDefinition<M extends StepStateMap> {
  /** Unique identifier for this process type */
  type: ProcessType;

  /** Starting step in the state machine when process is first created */
  initial: keyof M;

  /** Step handlers defining the process behavior */
  steps: StepsDefinition<M>;
}

/**
 * Attached to an event that will spawn a process when handled.
 * For process state initialization, refer to `handleEvent` implementation.
 */
export interface ProcessCall<T extends StateData = StateData> {
  /** Unique process type identifier */
  type: ProcessType;

  /**
   * Optional flag to control step inheritance from parent events.
   * When true, the process starts from the parent's current step instead of their definition's initial step.
   */
  inheritStep?: boolean;

  /**
   * Optional data that can be passed to the process.
   * Can be used to initialize process state.
   */
  data?: T;
}

// type ValidProcessState<M extends StepStateMap> = {
//   [K in keyof M]: { type: ProcessType; step: K; data: M[K] };
// }[keyof M];

type ProcessStateFor<M extends StepStateMap> = {
  [K in keyof M]: ProcessState<M[K], K & StepType>;
}[keyof M];

/**
 * A process handler is a function that executes the processing logic associated with an event, and returns a
 * process step.
 * Knowing the current simulation state, it is capable of computing the state of the process's next step.
 */
export type ProcessHandler<
  M extends StepStateMap,
  K extends keyof M,
> = (
  sim: Simulation,
  event: Event<M[K]>,
  state: ProcessState<M[K], K & StepType>,
) => ProcessStep<M>;

/**
 * This is a process-level structure that is used to keep track of a process's progress and data.
 * It is passed to the process handler of an event to compute the next step of the process.
 */
export interface ProcessState<
  T extends StateData = StateData,
  K extends StepType = StepType,
> {
  /** Unique process type identifier */
  type: ProcessType;

  /** Current step of the process */
  step: K;

  /** Current state data for the process */
  data: T;
}

/**
 * This is a scheduler-level data structure that is used to keep track of a process's progress and data.
 * It is returned by the process handler of an event and stored in the simulation state.
 */
export interface ProcessStep<M extends StepStateMap = StepStateMap> {
  /** Process handler returns the updated state of the process */
  state: ProcessStateFor<M>;

  /**
   * Process handler returns the next events to be scheduled.
   * This is expressed as a mapped tuple type:
   * - If `type O = [A, B, C]`, resolves to [Event<A>, Event<B>, Event<C>];
   * - Mapped types over tuples preserve order and length.
   */
  next: Event[];

  /**
   * TODO:
   */
  finish?: Event[];
}

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
 * Object used to configure a simulation run.
 * Allows setting the rate of simulation to map wall-clock speed to the virtual passing of time.
 * Allows setting either an end timestamp or an end event to stop the simulation at specific time.
 */
export interface RunSimulationOptions<T extends StateData = StateData> {
  /** Simulation speed in Hz (events per second) */
  rate?: number;

  /** Stop simulation when `currentTime` reaches this value */
  untilTime?: Timestamp;

  /** Stop simulation when this specific event finishes */
  untilEvent?: Event<T>;

  /** Optional run identifier. Defaults to a random UUID. */
  runId?: string;

  /**
   * Explicit run directory path. If omitted, defaults to `$runs/run-${runId}`.
   * If `run.json` exists in this directory, it is merged as run defaults.
   */
  runDirectory?: string;

  /** Overrides the simulation dump interval for this run. */
  dumpInterval?: number;

  /** Optional metadata merged into `run.json` for this run. */
  runMetadata?: Record<string, unknown>;
}

/**
 * Object used to create new events in the simulation. It must define a time to schedule the event at.
 * An event will always trigger a process. If no process is specified, the event will run the `none` process.
 * Optional parent-child relationships enable various inheritance patterns:
 * - No parent: New process with provided process definition;
 * - Parent without `inheritStep`: New process with parent data;
 * - Parent with `inheritStep`: Continue parent's process.
 */
export interface CreateEventOptions<T extends StateData = StateData> {
  /** Optional parent event ID for state inheritance patterns */
  parent?: EventID;

  /** If `true`, the event will not be scheduled for process execution */
  waiting?: boolean;

  /** Optional event priority for scheduling; lower value yields higher priority (cf. UNIX `nice`) */
  priority?: number;

  /** Simulation time when event will be processed */
  scheduledAt: Timestamp;

  /** Process to execute, defaults to a dummy `none` process */
  process?: ProcessCall<T>;
}

/** Discipline for managing the order of events in a store's queues */
export enum QueueDiscipline {
  FIFO = "FIFO",
  LIFO = "LIFO",
}

/**
 * Object used to create new stores in the simulation.
 * Stores enable (possibly blocking) coordination between processes via `get`/`put` operations.
 * Defaults to blocking operations with capacity for one single item.
 * Capacity determines how many items the store can hold before `put` operations block.
 * Blocking operations use `EventState.Waiting` to pause processes until conditions resolve.
 * Stores default to LIFO discipline for their queues, meaning the most recently added event will be the first to be processed when conditions allow.
 */
export interface CreateStoreOptions {
  /** Optional store ID for deterministic typing/registration */
  id?: StoreID;

  /** Maximum items the store can hold before `put` operations block */
  capacity?: number;

  /** Controls whether the store enables synchronous (blocking) or asynchronous coordination */
  blocking?: boolean;

  /** Discipline for managing the order of events in the store's queues */
  discipline?: QueueDiscipline;
}
