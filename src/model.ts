/**
 * Core simulation container that maintains:
 * - The current virtual time of the simulation
 * - All events that have been scheduled
 * - A process definition registry for all processes available in the simulation
 * - The current state of all running processes
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
   * Queue of all events in the system.
   * Includes:
   * - Newly scheduled but not yet processed events
   * - Partially processed events, which have related process execution state
   * - Completed events (for historical tracking)
   */
  events: Event[];

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

  /** Current state of all stores in the simulation, used for process synchronization */
  stores: StoreDefinitions<S>;

  /**
   * Configuration and count for automatic simulation dumps.
   * Used to periodically save simulation state to disk.
   */
  dump: { config: DumpConfig; count: number };
}

export interface DumpConfig {
  /**
   * Directory where simulation dumps will be saved. Must be configured before running the simulation to enable dumping.
   */
  directory: string;

  /** Working set of deltas between dumps */
  interval: number;
}

/**
 * Lifecycle states for events within the simulation.
 * Events progress through states with possible blocking at Waiting.
 */
export enum EventState {
  /**
   * Initial state when event is first created.
   * Indicates the event has been instantiated but not yet scheduled.
   */
  Fired = "Fired",

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

/**
 * Represents a discrete event in the simulation system.
 * Events can be tied to processes, which define their behavior.
 * Events are immutable - state changes are tied to new event instances.
 * Events can have parent-child relationships in the context of their process.
 */
export interface Event<T extends StateData = StateData> {
  /** Unique identifier for the event */
  id: EventID;

  /** Optional parent event ID; defines a graph of events across processes */
  parent?: EventID;

  /** Current lifecycle state of the event */
  status: EventState;

  /**
   * Optional event priority for scheduling; lower value yields higher priority (cf. UNIX `nice`).
   * Defaults to `0`.
   */
  priority: number;

  /**
   * When the event was initially created.
   * Represents the simulation time when `createEvent()` was called.
   */
  firedAt: Timestamp;

  /**
   * When the event should be processed.
   * Simulation time will jump directly to this value when processed.
   */
  scheduledAt: Timestamp;

  /**
   * When the event completed processing.
   * Only populated when `status` is `EventState.Finished`.
   */
  finishedAt?: Timestamp;

  /**
   * Type of process to execute when event is handled.
   * Defaults to `none`, which calls a no-op process.
   * Optional data can be used to initialize the process state.
   */
  process: ProcessCall<T>;
}

/**
 * Synchronization data structure used for coordinating processes.
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
  /** Continuation event for the calling process.
   * Must be scheduled by the process handler of the calling event.
   */
  step: Event<T>;

  /** Resume event for the blocked process, if any.
   * Used to resume a process that was blocked by a store operation when the conditions for resumption are met.
   * This is relevant for blocking stores where processes can be paused until certain conditions are satisfied (e.g., an item is put into the store or space becomes available).
   * In non-blocking scenarios, this may be `undefined` since the process can continue immediately without waiting for store conditions.
   */
  resume?: Event<T>;
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
 * Used to specify and narrow the type of input state data for a process.
 * This is the type of the state data that is passed to the process step handler.
 */
type StateInput = StateData;
/**
 * Used to specify and narrow the types of output state data for a process.
 * This is an ordered list of types that map to the `next` events yielded by a process step.
 */
type StateOutput = StateData[];

/** Maps process steps to their input and output state data types */
export type StepStateMap<
  I extends StateInput = StateInput,
  O extends StateOutput = StateOutput,
> = Record<StepType, [I, O]>;

/** Dynamically maps process steps to their corresponding handlers */
export type StepsDefinition<T extends StepStateMap> = {
  [K in keyof T]: ProcessHandler<T[K][0], T[K][1]>;
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

/**
 * A process handler is a function that executes the processing logic associated with an event, and returns a
 * process step.
 * Knowing the current simulation state, it is capable of computing the state of the process's next step.
 */
export type ProcessHandler<
  I extends StateInput = StateInput,
  O extends StateOutput = StateOutput,
> = (
  sim: Simulation,
  event: Event<I>,
  state: ProcessState<I>,
) => ProcessStep<I, O>;

/**
 * This is a process-level structure that is used to keep track of a process's progress and data.
 * It is passed to the process handler of an event to compute the next step of the process.
 */
export interface ProcessState<T extends StateData = StateData> {
  /** Unique process type identifier */
  type: ProcessType;

  /** Current step of the process */
  step: StepType;

  /** Current state data for the process */
  data: T;
}

/**
 * This is a scheduler-level data structure that is used to keep track of a process's progress and data.
 * It is returned by the process handler of an event and stored in the simulation state.
 */
export interface ProcessStep<
  I extends StateInput = StateInput,
  O extends StateOutput = StateOutput,
> {
  /** Process handler returns the updated state of the process */
  state: ProcessState<I>;

  /**
   * Process handler returns the next events to be scheduled.
   * This is expressed as a mapped tuple type:
   * - If `type O = [A, B, C]`, resolves to [Event<A>, Event<B>, Event<C>];
   * - Mapped types over tuples preserve order and length.
   */
  next: { [K in keyof O]: Event<O[K]> };
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
