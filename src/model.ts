/**
 * Core simulation container that maintains:
 * - The current virtual time of the simulation
 * - All events that have been scheduled
 * - A process definition registry for all processes available in the simulation
 * - The current state of all running processes
 */
export interface Simulation<R extends ProcessRegistry = ProcessRegistry> {
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
   * Maps process IDs to their current state data.
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
   * Will be executed when simulation time reaches `scheduledAt`.
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

/** Timestamp for simulation clock */
export type Timestamp = number;

/** Unique identifier for an event */
export type EventID = string;

/** Unique identifier for a process */
export type ProcessType = string;

/** Identifier for a step within a process. Unique at process level */
export type StepType = string;

/** Represents any data that can be stored in the simulation state */
export type StateData = Record<string, unknown>;

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

/** TODO: Not sure if that is useful... */
type ProcessRegistry = Record<string, ProcessDefinition<StepStateMap>>;

/** Defines a process with a unique type, initial step, and step definitions */
export interface ProcessDefinition<M extends StepStateMap> {
  type: ProcessType;
  initial: keyof M;
  steps: StepsDefinition<M>;
}

/**
 * Attached to an event that will spawn a process when handled.
 * FIXME: Not clear in current implementation:
 * - Process type and state can be passed through an event, but are ignored if the event has a parent
 * - In that case, process type and state are actually retrieved through the parent event ID
 */
export interface ProcessCall<T extends StateData = StateData> {
  /** Unique process type identifier */
  type: ProcessType;

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
  /** Process handler returns the original event; scheduler marks it as finished */
  updated: Event<I>;

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
 * TODO: Can be used to pass a socket to the simulation to allow for remote control.
 */
export interface RunSimulationOptions<T extends StateData = StateData> {
  rate?: number;
  untilTime?: Timestamp;
  untilEvent?: Event<T>;
}

/**
 * Object used to create new events in the simulation.
 * It must define a time to schedule the event at.
 * If the event has a parent, it will inherit the parent's process.
 * If no process is defined, the event will run the `none` process.
 */
export interface CreateEventOptions<T extends StateData = StateData> {
  parent?: EventID;
  scheduledAt: Timestamp;
  process?: ProcessCall<T>;
}
