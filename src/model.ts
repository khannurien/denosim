/**
 * Core simulation container that maintains:
 * - The current virtual time of the simulation
 * - The simulation timeline (events along with their state transitions)
 * - `processes`: registry of all process definitions available in the simulation
 * - `disciplines`: registry of queue discipline implementations used by stores
 * - `predicates`: registry of predicate functions used by `getWhere`
 * - `states`: process state saved by each handled event
 * - `stores`: all resource stores registered for use in process handlers
 */
export interface Simulation<
  S extends StoreItemMap = StoreItemMap,
> {
  /**
   * The current virtual time in the simulation.
   * Represents the timestamp up to which the simulation has processed.
   * Measured in arbitrary time units (could be steps, seconds, etc.).
   */
  currentTime: Timestamp;

  /**
   * Full lifecycle record for every event in the simulation.
   * Combines immutable event definitions with the append-only transition log and derived status index that makes queries O(1).
   */
  timeline: Timeline;

  /**
   * Registry of all process definitions available in the simulation.
   * Maps process names to their definitions.
   * Allows dynamic process registration and lookup.
   * Includes a default `none` process for events without associated processes.
   */
  processes: ProcessRegistry;

  /**
   * Registry of queue discipline implementations used by stores.
   * Maps discipline keys to their comparator definitions.
   * Never serialized; re-injected at deserialization time alongside `processes`.
   * Pre-populated with `FIFO` and `LIFO` by `initializeSimulation`.
   */
  disciplines: DisciplineRegistry;

  /**
   * Registry of predicate functions used by `getWhere`.
   * Maps predicate keys to their implementations.
   * Never serialized; re-injected at deserialization time alongside `processes`.
   */
  predicates: PredicateRegistry;

  /**
   * Process state returned by the handler of each handled event, keyed by event ID.
   * An event with a `parent` inherits from the state saved under that ID.
   */
  states: Record<EventID, ProcessState>;

  /**
   * Current state of all stores in the simulation.
   * Stores may be used for inter-process communications (message passing, data sharing, synchronization, etc.).
   */
  stores: StoreRegistry<S>;
}

/**
 * The registries of a simulation: `processes`, `disciplines` and `predicates`.
 * Never serialized; passed back in when a simulation is restored. Any `Simulation` can be passed where registries are expected.
 */
export type SimulationRegistries = Pick<
  Simulation,
  "processes" | "disciplines" | "predicates"
>;

/**
 * Parallel data structures that together describe the full lifecycle of every event:
 * - `events`: immutable event definitions, keyed by ID (what the event is)
 * - `transitions`: append-only log of every status change (when and how it progressed)
 * - `status`: denormalized current-status index derived from `transitions` (fast O(1) lookup)
 *
 * `transitions` is the source of truth for event progression; `status` is a derived cache.
 * Together they bound each event's lifetime: the first transition records when it was scheduled (or placed in waiting), and subsequent transitions record status changes through to `Finished`.
 *
 * `transitions` is append-only and grows with the simulation; old entries are pruned at each dump via `pruneWorkingState` while the full history remains on disk.
 */
export interface Timeline {
  /** Immutable event definitions keyed by event ID */
  events: Record<EventID, Event>;

  /** Always reflects the most recent transition for each event ID */
  status: Record<EventID, EventStatus>;

  /** Append-only source of truth for event progression */
  transitions: EventTransition[];
}

/**
 * Lifecycle statuses for events within the simulation.
 * An event is either `Scheduled` then `Finished`, or `Waiting` then `Finished`.
 */
export enum EventStatus {
  /**
   * Event has been scheduled for future processing.
   * Will be executed when simulation time reaches `scheduledAt`.
   */
  Scheduled = "Scheduled",

  /**
   * Event stands for a blocked process waiting for external conditions; it is never handled.
   * Used by store operations and synchronization primitives.
   * Events keep this status until marked `Finished`; the process is resumed by a new event.
   */
  Waiting = "Waiting",

  /**
   * Final status indicating the event has been fully processed.
   * Events with this status remain in the system for historical tracking.
   */
  Finished = "Finished",
}

/** Append-only event lifecycle transition entry */
export interface EventTransition {
  /** Event identifier affected by this transition */
  id: EventID;

  /** Lifecycle status reached by the event */
  status: EventStatus;

  /** Simulation timestamp when the transition occurred */
  at: Timestamp;
}

/**
 * Represents a discrete event in the simulation system.
 * Events can be tied to processes, which define their behavior.
 * Event definitions are immutable; lifecycle progression is represented through `EventTransition` entries.
 * Events can have parent-child relationships in the context of their process.
 * Events can be created with a `waiting` attribute that places them directly in `EventStatus.Waiting`: they are never handled, and stand for a blocked process until marked `Finished`.
 * Events scheduled at the same timestamp will be selected based on their priority (the lower the value, the higher the priority). In case of a tie, the scheduler dequeues events in FIFO order (first scheduled, first served).
 */
export interface Event<T extends StateData = StateData> {
  /** Unique identifier for the event */
  id: EventID;

  /** Optional parent event ID: the event this one continues the process of */
  parent?: EventID;

  /** If `true`, the event will not be scheduled for process execution */
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
 * An entry in a heap-backed store request queue.
 * Passed as is to discipline comparators, as a `DisciplineEntry`: `seq` is a monotonically increasing insertion counter.
 */
export interface StoreQueueEntry<T extends StateData = StateData> {
  /** The stored event */
  event: Event<T>;

  /** Monotonic insertion counter for arrival-order semantics, stamped to the entry */
  seq: number;
}

/**
 * Heap-backed queue for store request tracking (`buffer`, `getRequests`, `putRequests`).
 * Enables O(log N) enqueue and dequeue per store operation.
 */
export interface StoreQueue<T extends StateData = StateData> {
  /** The stored entry */
  entries: StoreQueueEntry<T>[];

  /** Monotonically increasing insertion counter */
  seq: number;
}

/**
 * An entry in `getWhereRequests`: a blocked event paired with the predicate key used to look up the predicate function in `sim.predicates` at runtime.
 * Stored as a string key (not the function itself) so entries survive JSON serialization.
 */
export interface GetWhereRequest<T extends StateData = StateData> {
  /** The blocked request */
  event: Event<T>;

  /** A condition that must be satisfied to unblock the request */
  predicateType: PredicateType;

  /** Arrival order, stamped from the `getRequests` counter so that both kinds of consumers can be compared */
  seq: number;
}

/**
 * Shared data structure used for coordinating processes.
 * Stores are used through `get`, `put`, `getWhere` and `cancel` primitives.
 * Used for inter-process synchronization, producer-consumer patterns, resource sharing, etc.
 */
export interface Store<T extends StateData = StateData> {
  /**
   * Maximum items the store can hold before `put` operations block.
   * Defaults to `0`: synchronous, a `put` waits for a `get`.
   */
  capacity: number;

  /**
   * Discipline key for managing the selection order among available items (`buffer`, `putRequests`).
   * Must be registered in `sim.disciplines`. Defaults to `FIFO`.
   * Built-in keys `FIFO` and `LIFO` are always available.
   */
  discipline: DisciplineType;

  /**
   * Discipline key for managing the selection order among blocked consumers (`getRequests`, `getWhereRequests`).
   * Must be registered in `sim.disciplines`. Defaults to `FIFO`.
   */
  consumerDiscipline: DisciplineType;

  /** Items currently held by the store and awaiting consumption */
  buffer: StoreQueue<T>;

  /** Processes blocked waiting to get items; their events carry the data of the consumer's process, not an item */
  getRequests: StoreQueue;

  /** Processes blocked waiting to put items */
  putRequests: StoreQueue<T>;

  /**
   * Processes blocked on a `getWhere` call, waiting for an item that satisfies their predicate.
   * Each entry pairs the waiting event with the predicate key used to look up the predicate function in `sim.predicates`.
   * `predicateType` is a plain string and is fully JSON-serializable. The predicate function is resolved from `predicates` at runtime.
   */
  getWhereRequests: GetWhereRequest[];
}

/**
 * Returned by store operations to indicate the outcome in terms of continuation and possible resume events.
 * `step`, `resume` and `finish` are control flow, to be passed on by the handler; `T` is the type of the store's items.
 */
export interface StoreResult<T extends StateData = StateData> {
  /**
   * Continuation event for the calling process.
   * Must be scheduled by the process handler of the calling event.
   */
  step: Event;

  /**
   * Item received by a `get` or `getWhere` that completed immediately; `undefined` when the caller blocks.
   * Either way, the item arrives with the event that runs the next step, as its data.
   */
  item?: T;

  /**
   * Resume event for the blocked process, if any.
   * Used to resume a process that was blocked by a store operation when the conditions for resumption are met.
   * Processes are paused until certain conditions are satisfied (e.g., an item is put into the store or space becomes available).
   * `undefined` when the operation unblocks no process.
   */
  resume?: Event[];

  /**
   * Events to explicitly mark as `Finished` as a side effect of the store operation.
   * Typically used to clean up waiting request events once the blocked condition they represent has been resolved.
   */
  finish?: Event[];
}

/** Timestamp for simulation clock */
export type Timestamp = number;

/** Unique, random identifier for an event */
export type EventID = string;

/** Unique, user-defined identifier for a store: its key in `sim.stores` */
export type StoreID = string;

/** Unique, user-defined identifier for a process */
export type ProcessType = string;

/** Unique identifier for a running process: the ID of the event that started it */
export type ProcessID = EventID;

/** User-defined identifier for a step within a process. Unique at process level */
export type StepType = string;

/** Represents any data that can be stored in the simulation state */
export type StateData = Record<string, unknown>;

/** Maps store IDs to their item types */
export type StoreItemMap = Record<StoreID, StateData>;

/** Dynamically maps store IDs to their corresponding stores */
export type StoreRegistry<R extends StoreItemMap> = {
  [K in keyof R]: Store<R[K]>;
};

/**
 * Used to specify and narrow the type of input state data for a process step.
 * Associates a process step to the type of the state data that is passed to the process step handler.
 */
export type StepStateMap = Record<StepType, StateData>;

/** Dynamically maps process steps to their corresponding handlers */
export type StepsDefinition<
  M extends StepStateMap,
  S extends StoreItemMap = StoreItemMap,
  I extends StepEventMap<M> = Record<never, never>,
> = {
  [K in keyof M]: ProcessHandler<M, K, S, I>;
};

/**
 * Used to specify the type of what the event running a process step brings: an item received from a store, or the data of a continuation.
 * `undefined` is part of the type when the event may bring nothing (e.g. an item or a timeout).
 * A step left out is run by an event whose data is not typed.
 */
export type StepEventMap<M extends StepStateMap> = {
  [K in keyof M]?: StateData | undefined;
};

/** The event passed to the handler of step `K`: its data is typed, and always there, if `I` declares the step */
export type StepEvent<I, K> = K extends keyof I
  ? Omit<Event, "process"> & { process: { type: ProcessType; data: I[K] } }
  : Event;

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
 * `S` optionally declares the stores used by the process (store ID to item type), so that store operations in its handlers are checked.
 * `I` optionally declares what the event running a step brings (step to data type), so that its handler reads it typed.
 * `N` optionally names the initial step, so that `createEvent` checks the data of a process started by its definition; a process with a single step needs none.
 */
export interface ProcessDefinition<
  M extends StepStateMap,
  S extends StoreItemMap = StoreItemMap,
  I extends StepEventMap<M> = Record<never, never>,
  N extends keyof M = keyof M,
> {
  /** Unique identifier for this process type */
  type: ProcessType;

  /** Starting step in the state machine when process is first created */
  initial: N;

  /** Step handlers defining the process behavior */
  steps: StepsDefinition<M, S, I>;
}

/**
 * Attached to an event that will start or continue a process when handled.
 * For process state initialization, refer to `runStep` implementation.
 */
export interface ProcessCall<T extends StateData = StateData> {
  /** Unique process type identifier */
  type: ProcessType;

  /**
   * Optional data brought by the event.
   * Initializes the process state when the event starts a process; otherwise read by the handler from its event, and never merged into the process state.
   */
  data?: T;
}

/**
 * Used as the type of the `state` field in `StepResult<M>`, ensuring that a handler can only return a state that names a step actually defined in the process and pairs it with the correct data type for that step.
 */
export type ProcessStateFor<M extends StepStateMap> = {
  [K in keyof M]: ProcessState<M[K], K & StepType>;
}[keyof M];

/**
 * A process handler is a function that executes the processing logic associated with an event, and returns a
 * process step.
 * Knowing the current simulation state, it is capable of computing the state of the process's next step.
 * `state.data` is what the previous step returned, or the initial data of a new process; `event.process.data` is what the event brings (an item, the data of a continuation), for the handler to keep in the state it returns if needed.
 * Of `sim`, a handler reads `currentTime` and passes it to store operations. `timeline` and `states` are not for it: a run drops finished events from them as it goes. An event to finish or cancel later is kept in the process data.
 */
export type ProcessHandler<
  M extends StepStateMap,
  K extends keyof M,
  S extends StoreItemMap = StoreItemMap,
  I extends StepEventMap<M> = Record<never, never>,
> = (
  sim: Simulation<S>,
  event: StepEvent<I, K>,
  state: ProcessState<M[K], K & StepType>,
) => StepResult<M>;

/**
 * This is a process-level structure that is used to keep track of a process's progress and data.
 * It is passed to the process handler of an event to compute the next step of the process.
 */
export interface ProcessState<
  T extends StateData = StateData,
  K extends StepType = StepType,
> {
  /**
   * Unique identifier for the process: the ID of the event that started it.
   * Carried along continuations; forked copies share it.
   */
  id: ProcessID;

  /** Unique process type identifier */
  type: ProcessType;

  /** Step the process is at: the one being run in a handler; in a returned state, the one its next event will run */
  step: K;

  /** Current state data for the process */
  data: T;
}

/**
 * This is a scheduler-level data structure that is used to keep track of a process's progress and data.
 * It is returned by the process handler of an event and stored in the simulation state.
 */
export interface StepResult<M extends StepStateMap = StepStateMap> {
  /** Process handler returns the updated state of the process */
  state: ProcessStateFor<M>;

  /** Process step handler returns the next events to be scheduled */
  next: Event[];

  /**
   * Optional events to explicitly mark as `Finished` after this step.
   * Used when the handler needs to terminate events currently in `EventStatus.Waiting`.
   */
  finish?: Event[];
}

/**
 * Object used to create new events in the simulation. It must define a time to schedule the event at.
 * An event will always trigger a process. If no process is specified, the event will run the `none` process.
 * The optional parent tells a new process from a continuation:
 * - No parent: New process with provided process definition;
 * - Parent: Continue parent's process, at its current step, under its process ID.
 */
export interface CreateEventOptions<
  T extends StateData = StateData,
  N extends StepType = StepType,
> {
  /** Optional parent event ID: the event this one continues the process of */
  parent?: EventID;

  /** If `true`, the event will not be scheduled for process execution */
  waiting?: boolean;

  /** Optional event priority for scheduling; lower value yields higher priority (cf. UNIX `nice`) */
  priority?: number;

  /** Simulation time when event will be processed */
  scheduledAt: Timestamp;

  /**
   * Process to execute, defaults to a dummy `none` process.
   * Named by its type, or by its definition: the data is then checked against the state of its initial step.
   */
  process?: ProcessCall<T> | ProcessStart<N, T>;
}

/**
 * A process to start, named by its definition: `data` is the state of its initial step, `N`.
 * The initial step of a definition with several steps must be named in its type (see `ProcessDefinition`).
 */
export interface ProcessStart<
  N extends StepType = StepType,
  T extends StateData = StateData,
> {
  /** Definition of the process to start */
  type: {
    type: ProcessType;
    initial: N;
    steps: Record<
      N,
      (sim: never, event: never, state: ProcessState<T, N>) => unknown
    >;
  };

  /** State of the initial step; `{}` for a process without data */
  data: T;
}

/** Unique, user-defined identifier for a queue discipline */
export type DisciplineType = string;

/**
 * An entry presented to a discipline comparator.
 * `seq` is the entry's arrival order in its queue (lower = arrived earlier); it is not a position.
 * `event` carries the full event, including `process.data`: the item under a store's `discipline`, the data of a blocked consumer under its `consumerDiscipline`.
 *
 * The `seq` field enables arrival-order policies (FIFO/LIFO).
 * The `event` field enables data-based policies (priority, EDF, etc.).
 * Both may be combined, e.g. data-based ordering with FIFO as a tiebreak.
 */
export type DisciplineEntry<T extends StateData = StateData> = {
  readonly event: Event<T>;
  readonly seq: number;
};

/**
 * A ranking function over two queue candidates.
 * Returns negative if `a` should be selected over `b`, positive for `b` over `a`, zero for a tie.
 */
export type DisciplineComparator<T extends StateData = StateData> = (
  a: DisciplineEntry<T>,
  b: DisciplineEntry<T>,
) => number;

/**
 * Defines a named queue discipline with its comparator implementation.
 * Registered in `sim.disciplines` via `registerDiscipline`.
 * `T` narrows the payload type visible inside the comparator, so callers can access `a.event.process.data` without casting.
 * The registry stores disciplines with `T` erased to `StateData`; the narrowing is enforced at registration time.
 */
export interface DisciplineDefinition<
  K extends DisciplineType = DisciplineType,
  T extends StateData = StateData,
> {
  /** Unique identifier for this discipline */
  type: K;

  /**
   * The ranking function that selects among queue candidates.
   * See `DisciplineComparator` for semantics.
   */
  comparator: DisciplineComparator<T>;
}

/**
 * Maps discipline type keys to their definitions.
 * `D` is the union of valid discipline keys for this registry.
 * The registry itself is never serialized; `Store.discipline` stores only the key.
 */
export type DisciplineRegistry<D extends DisciplineType = DisciplineType> = {
  [K in D]: DisciplineDefinition<K>;
};

/**
 * Discipline for managing the selection order of events in a store's queues.
 * FIFO: Selects the item that entered the queue first (lowest `seq`).
 * LIFO: Selects the item that entered the queue most recently (highest `seq`).
 */
export const enum QueueDiscipline {
  FIFO = "FIFO",
  LIFO = "LIFO",
}

/** Unique name for a store filtering predicate over item events */
export type PredicateType = string;

/**
 * Predicate function for store filtering over item events.
 * `request` stands for the consumer: the event `getWhere` was called with, or the blocked request made from it; both carry the data of the consumer's process, as its handler received it.
 */
export type Predicate<
  T extends StateData = StateData,
  R extends StateData = StateData,
> = (
  event: Event<T>,
  request: Event<R>,
) => boolean;

/**
 * Registry mapping predicate keys to their implementations.
 * Predicates must be registered in `sim.predicates` using `registerPredicate`.
 * The registry is never serialized; re-injected at deserialization time via `deserializeSimulation`.
 */
export type PredicateRegistry = Record<PredicateType, Predicate>;

/**
 * Defines a named predicate with its implementation.
 * Registered in `sim.predicates` via `registerPredicate`.
 */
export interface PredicateDefinition<
  T extends StateData = StateData,
  K extends PredicateType = PredicateType,
  R extends StateData = StateData,
> {
  /** Unique identifier for this predicate */
  type: K;

  /** The predicate function that filters store items; `R` narrows the data of the consumer's request */
  predicate: Predicate<T, R>;
}

/**
 * Object used to create new stores in the simulation.
 * Stores enable (possibly blocking) coordination between processes via `get`/`put`/`getWhere` operations.
 * Defaults to a capacity of `0`: synchronous, a `put` waits for a `get`.
 * Capacity determines how many items the store can hold before `put` operations block.
 * Blocking operations use `EventStatus.Waiting` to pause processes until conditions resolve.
 * Stores default to `FIFO` disciplines. A custom discipline is given as its definition, and must be registered in `sim.disciplines`.
 * `T` is the type of the store's items.
 */
export interface CreateStoreOptions<T extends StateData = StateData> {
  /** Maximum items the store can hold before `put` operations block; defaults to `0` */
  capacity?: number;

  /**
   * Discipline controlling selection order among available items: a built-in key, or a definition over the items of the store.
   * The definition is checked against `T`, and does not decide it; a store whose items are not typed takes any.
   * A definition must be registered in `sim.disciplines` using `registerDiscipline`. Defaults to `FIFO`.
   */
  discipline?:
    | QueueDiscipline
    | `${QueueDiscipline}`
    | DisciplineDefinition<
      DisciplineType,
      StateData extends T ? never : NoInfer<T>
    >;

  /**
   * Discipline controlling selection order among blocked consumers: a built-in key, or a definition over the data their requests carry.
   * That data is the one of any process that blocks on the store: it is not checked.
   * A definition must be registered in `sim.disciplines` using `registerDiscipline`. Defaults to `FIFO`.
   */
  consumerDiscipline?:
    | QueueDiscipline
    | `${QueueDiscipline}`
    | DisciplineDefinition<DisciplineType, never>;
}
