/**
 * Core simulation container that maintains:
 * - The current virtual time of the simulation
 * - All events that have been scheduled
 */
export interface Simulation {
  /**
   * The current virtual time in the simulation.
   * Represents the timestamp up to which the simulation has processed.
   * Measured in arbitrary time units (could be steps, seconds, etc.).
   */
  currentTime: number;

  /**
   * Queue of all events in the system.
   * Includes:
   * - Newly scheduled but not yet processed events
   * - Partially processed events, which have related process execution state
   * - Completed events (for historical tracking)
   */
  events: Event<unknown>[];

  /**
   * TODO:
   */
  registry: Record<string, ProcessDefinition<unknown, unknown>>;

  /**
   * TODO:
   */
  state: Record<string, ProcessState<unknown, unknown>>;
}

/**
 * Lifecycle states for events within the simulation.
 * Follows a strict progression: Fired → Scheduled → Finished
 */
export enum EventState {
  /**
   * Initial state when event is first created.
   * Indicates the event has been instantiated but not yet scheduled.
   */
  Fired = "Fired",

  /**
   * Event has been scheduled for future processing.
   * Will be executed when simulation time reaches scheduledAt.
   */
  Scheduled = "Scheduled",

  /**
   * Final state indicating the event has been fully processed.
   * Events in this state remain in the system for historical tracking.
   */
  Finished = "Finished",
}

/**
 * Represents a discrete event in the simulation system.
 * Events are immutable - state changes create new instances.
 */
export interface Event<T = void> {
  /** Unique identifier for the event */
  id: string;

  /** Current lifecycle state of the event */
  status: EventState;

  /**
   * When the event was initially created.
   * Represents the simulation time when createEvent() was called.
   */
  firedAt: number;

  /**
   * When the event should be processed.
   * Simulation time will jump directly to this value when processed.
   */
  scheduledAt: number;

  /**
   * When the event completed processing.
   * Only populated when status = EventState.Finished
   */
  finishedAt?: number;

  /**
   * Optional item that can be passed through the event.
   */
  item?: T;

  /**
   * TODO:
   */
  callback: ProcessType;
}

/**
 * TODO:
 */
export type ProcessType = string;

/**
 * TODO:
 */
export type StepType = string;

/**
 * TODO:
 */
export interface ProcessDefinition<S = void, T = void> {
  type: ProcessType;
  initial: StepType;
  states: Record<StepType, ProcessHandler<S, T>>;
}

/**
 * TODO:
 */
export type ProcessHandler<S = void, T = void> = (
  sim: Simulation,
  event: Event<T>,
  state: ProcessState<S, T>,
) => ProcessStep<S, T>;

/**
 * TODO: Process level
 */
export interface ProcessState<S = void, T = void> {
  type: ProcessType;
  step: StepType;
  data: S;
  result?: T;
}

/**
 * TODO: Scheduler level
 */
export interface ProcessStep<S = void, T = void> {
  updated: Event<T>;
  state: ProcessState<S, T>;
  next?: Event<T>;
}

/**
 * Statistics about a simulation run.
 * Currently tracks only duration, but could be extended with:
 * - Events processed count
 * - Average event latency
 * - Other performance metrics
 */
export interface SimulationStats {
  /** Real-world time (in milliseconds) the simulation took to complete */
  duration: number;
}

/**
 * Utility data structure for inter-process synchronization.
 * Put/Get operations (see resources.ts) work in a FIFO fashion.
 */
export interface Store<T> {
  /**
   * Maximum number of items a store can hold at any time.
   * If a put request is fired and capacity is already reached,
   * the request will be delayed.
   */
  readonly capacity: number;

  /**
   * Array of pending get requests in the store.
   * Earliest requests will be handled first.
   */
  getRequests: Event<T>[];

  /**
   * Array of pending put requests in the store.
   * Earliest requests will be handled first.
   */
  putRequests: Event<T>[];

  /**
   * Array of delayed put requests in the store.
   * Requests can be delayed because store capacity has been reached,
   * or because a blocking put request has been fired and is waiting for a get request.
   * Earliest requests will be handled first.
   */
  delayedPutRequests: Event<T>[];
}
