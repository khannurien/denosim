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
   * - Partially processed events with generator state
   * - Completed events (for historical tracking)
   */
  events: Event<unknown>[];

  /**
   * Optional generator state for multi-step processes.
   * Generators are associated with their original event ID.
   * Preserves execution context between partial processing runs.
   */
  state: Record<string, ProcessState<unknown>>;
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
 * Holds the state of the ongoing process for an event in a generator.
 * Can yield an event for execution continuation.
 * Can return a final value.
 */
export type ProcessState<T = void> = Generator<
  Event<T> | undefined,
  ProcessReturn<T>,
  ProcessReturn<T>
>;

/**
 * Represents a step of event handling. It holds:
 * - A copy of the original event, updated after it has been handled;
 * - The current state of its associated process;
 * - A successor event to schedule in case of a multi-step process.
 */
export interface ProcessStep<T = void> {
  /** The updated event */
  updated: Event<T>;

  /** The current process state */
  state: ProcessState<T>;

  /** Optional next event to be scheduled */
  next?: Event<T>;
}

/**
 * Holds the simulation state updated after a process step.
 * Returned by the process generator, and fed into its next step.
 */
export interface ProcessReturn<T = void> {
  /** The updated simulation */
  sim: Simulation;

  /** The updated original event */
  event: Event<T>;
}

/**
 * Type definition for event process logic.
 * Generator function that defines an event's behavior.
 * Can yield to pause execution and schedule intermediate events.
 */
export type Process<T = void> = (
  sim: Simulation, // Reference to the running simulation
  event: Event<T>, // The event instance being processed
) => ProcessState<T>; // Generator that can yield events or nothing

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
   * The process logic to execute when this event is processed.
   * Generator function that can yield to pause/resume execution.
   */
  callback: Process<T>;
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
