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
  events: Event[];

  /**
   * TODO:
   */
  registry: Record<string, ProcessDefinition>;

  /**
   * TODO:
   */
  state: Record<string, ProcessState>;
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
export interface Event<T extends StateData = StateData> {
  /** Unique identifier for the event */
  id: EventID;

  /** TODO: */
  parent?: EventID;

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
   * TODO:
   * TODO: Defaults to `none`, which calls a no-op process.
   */
  process: ProcessCall<T>;
}

/** TODO: */
export type EventID = string;

/** TODO: */
export type ProcessType = string;

/** TODO: */
export type StepType = string;

/** TODO: */
export type StateData = Record<string, unknown>;

/**
 * TODO:
 */
export interface ProcessDefinition<T extends StateData = StateData> {
  type: ProcessType;
  initial: StepType;
  states: Record<StepType, ProcessHandler<T>>;
}

export interface ProcessCall<T extends StateData = StateData> {
  /** TODO: */
  type: ProcessType;

  /**
   * Optional data that can be passed to the process.
   * TODO: Can be used to initialize process state.
   */
  data?: T;
}

/**
 * TODO:
 */
export type ProcessHandler<T extends StateData = StateData> = (
  sim: Simulation,
  event: Event<T>,
  state: ProcessState<T>,
) => ProcessStep<T>;

/**
 * TODO: Process level
 */
export interface ProcessState<T extends StateData = StateData> {
  type: ProcessType;
  step: StepType;
  data: T;
}

/**
 * TODO: Scheduler level
 */
export interface ProcessStep<
  T extends StateData = StateData,
> {
  updated: Event<T>;
  state: ProcessState<T>;
  /**
   * TODO: Can be leveraged to spawn a new process
   * TODO: State will be initialized on process start
  */
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
 * TODO:
 */
export interface CreateEventOptions<T extends StateData = StateData> {
  parent?: EventID;
  scheduledAt: number;
  process?: ProcessCall<T>;
}
