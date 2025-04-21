import {
  Event,
  EventState,
  Process,
  ProcessState,
  ProcessStep,
  Simulation,
  SimulationStats,
} from "./model.ts";

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty events array (no scheduled events)
 */
export function initializeSimulation(): Simulation {
  return {
    currentTime: 0,
    events: [],
    state: {},
  };
}

/**
 * Runs the discrete-event simulation until no more events remain to process.
 * The simulation processes events in chronological order (earliest first).
 * FIXME: The simulation instance is updated at each simulation step.
 * Returns the last simulation instance along with statistics about the simulation run.
 */
export function runSimulation(sim: Simulation): [Simulation, SimulationStats] {
  const start = performance.now();

  // TODO: Termination conditions
  // - End time (simulation stops when currentTime >= endTime)
  // - End event (simulation stops when endEvent.status === EventState.Finished)
  while (true) {
    // Get all scheduled events that haven't been processed yet,
    // sorted in descending order so we can efficiently pop the earliest event
    const eventsTodo = sim.events.filter((event) =>
      (event.scheduledAt >= sim.currentTime) &&
      (event.status === EventState.Scheduled)
    ).sort((a, b) => b.scheduledAt - a.scheduledAt);

    const event = eventsTodo.pop();

    if (!event) {
      break; // No more events to process
    }

    // FIXME: Review logic -- avoid mutating function parameter
    // TODO: Use a generator to yield the next simulation value?
    sim = step(sim, event);
  }

  const end = performance.now();

  return [
    sim,
    {
      duration: end - start, // Return real-world time taken for simulation
    },
  ];
}

/**
 * Processes the simulation for one step, i.e. handles the current event,
 * and possibly schedules a next one.
 * Advances the simulation time to the current event scheduled time.
 * Updates the state of the process associated with the current event.
 * Updates the event queue with the updated current event.
 * Returns an updated copy of the original simulation container.
 */
export function step(sim: Simulation, event: Event<unknown>): Simulation {
  // Advance simulation time to this event's scheduled time
  const nextSim = { ...sim, currentTime: event.scheduledAt };

  // Handle the event by executing its process, which may yield a new event
  const { updated, state, next } = handleEvent(nextSim, event);

  // Update the event's process state in the simulation container
  nextSim.state = { ...nextSim.state, [updated.id]: state };

  // Update the event instance in the event queue if necessary
  nextSim.events = nextSim.events.map((previous) =>
    (previous.id === event.id) ? updated : previous
  );

  // Schedule the next event yielded by the current process
  if (next) {
    nextSim.events = scheduleEvent(nextSim, next);
  }

  return nextSim;
}

/**
 * Creates a new event with:
 * - Unique ID
 * - Initial state set to `Fired`
 * - Timestamps for when it was created and scheduled
 * - Optional callback process (defaults to empty generator)
 * - Optional item to carry (defaults to undefined)
 */
export function createEvent<T>(
  sim: Simulation,
  scheduledAt: number,
  callback?: Process<T>,
  item?: T,
): Event<T> {
  return {
    id: crypto.randomUUID(),
    status: EventState.Fired,
    firedAt: sim.currentTime,
    scheduledAt,
    callback: callback ?? function* () {
      return yield;
    },
    item,
  };
}

/**
 * Schedules an event for future processing in the simulation.
 * Validates that the event isn't scheduled in the past.
 * Returns updated events array with the new scheduled event.
 */
export function scheduleEvent<T>(
  sim: Simulation,
  event: Event<T>,
): Event<unknown>[] {
  if (event.scheduledAt < sim.currentTime) {
    throw RangeError(
      `Event scheduled at a point in time in the past: ${event.id} ` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  return [
    ...sim.events,
    { ...event, status: EventState.Scheduled } as Event<unknown>,
  ];
}

/**
 * Processes an event by executing its generator function.
 * Handles both immediate completion and yielding of new events.
 * Returns the completed event with updated status and timestamps.
 */
export function handleEvent<T>(
  sim: Simulation,
  event: Event<T>,
): ProcessStep<T> {
  // Get the generator - either from previous partial execution or a new one
  const generator = sim.state[event.id] as ProcessState<T> ??
    event.callback(sim, event);
  // Execute next step of the generator
  const { value, done } = generator.next({ sim, event });

  // If generator yielded a value (new event to schedule) and isn't done
  if (!done && value) {
    // The original process yielded a new event
    // We will wait for that new event to be handled before continuing the original event
    // Return the event updated with continuation metadata along with its current state
    // Return the new event to be scheduled
    return value.id !== event.id
      ? {
        updated: {
          ...event,
          // Synchronization between original process end and yielded process start
          scheduledAt: value.scheduledAt,
        },
        state: generator,
        next: value,
      }
      : {
        updated: { ...value },
        state: generator,
      };
  }

  // The event has been fully handled
  // Return completed event with updated metadata
  // There is no next event to process
  return {
    updated: {
      ...event,
      finishedAt: sim.currentTime,
      status: EventState.Finished,
    },
    state: generator,
  };
}

/**
 * Generator function that creates and schedules a timeout event.
 * This is a utility for creating delayed events in the simulation.
 * Yields control until the timeout duration has passed.
 */
export function* timeout<T = void>(
  sim: Simulation,
  duration: number,
  callback?: Process<T>,
  item?: T,
): ProcessState<T> {
  // Fire an event that will be scheduled after specified duration
  const timeoutEvent = createEvent<T>(
    sim,
    sim.currentTime + duration,
    callback,
    item,
  );

  // Yield continuation (allowing other code to run until timeout completes)
  const step = yield timeoutEvent;

  // Return the updated context for closure continuation
  return step;
}
