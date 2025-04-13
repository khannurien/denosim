import {
  Event,
  EventState,
  Process,
  ProcessStep,
  Simulation,
  SimulationStats,
} from "./model.ts";

/**
 * Initializes a new simulation instance with:
 * - currentTime set to 0 (starting point of simulation)
 * - Empty events array (no scheduled events)
 */
export function initializeSimulation(): Simulation {
  return {
    currentTime: 0,
    events: [],
  };
}

/**
 * Runs the discrete-event simulation until no more events remain to process.
 * The simulation processes events in chronological order (earliest first).
 * Returns statistics about the simulation run.
 */
export function runSimulation(sim: Simulation): SimulationStats {
  const start = performance.now();

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

    // Advance simulation time to this event's scheduled time
    sim.currentTime = event.scheduledAt;

    // Process the event and get its final state
    const finished = handleEvent(sim, event);

    // Update the simulation's events queue
    sim.events = sim.events.map((previous) =>
      (previous.id === event.id) ? finished : previous
    );
  }

  const end = performance.now();

  return {
    duration: end - start, // Return real-world time taken for simulation
  };
}

/**
 * Creates a new event with:
 * - Unique ID
 * - Initial state set to "Fired"
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
      yield;
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
export function handleEvent<T>(sim: Simulation, event: Event<T>): Event<T> {
  // Get the generator - either from previous partial execution or a new one
  const generator = event.generator ?? event.callback(sim, event);
  // Execute next step of the generator
  const { value, done } = generator.next();

  // If generator yielded a value (new event to schedule) and isn't done
  if (!done && value) {
    // Schedule the new event
    if (value.id !== event.id) {
      sim.events = scheduleEvent(sim, value);
    }

    // Return the continuation event,
    // by updating the original event with continuation data
    return {
      ...event,
      firedAt: sim.currentTime,
      scheduledAt: value.scheduledAt,
      item: value.item,
      generator, // Save generator state for next execution
    };
  }

  // Return completed event with updated metadata
  return {
    ...event,
    finishedAt: sim.currentTime,
    status: EventState.Finished,
  };
}

/**
 * Generator function that creates and schedules a timeout event.
 * This is a utility for creating delayed events in the simulation.
 * Yields control until the timeout duration has passed.
 */
export function* timeout<T>(
  sim: Simulation,
  duration: number,
  callback?: Process<T>,
  item?: T,
): ProcessStep<T> {
  // Fire an event that will be scheduled after specified duration
  const timeoutEvent = createEvent<T>(
    sim,
    sim.currentTime + duration,
    callback,
    item,
  );

  // Yield continuation (allowing other code to run until timeout completes)
  yield timeoutEvent;
}
