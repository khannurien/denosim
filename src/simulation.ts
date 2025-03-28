import {
  Event,
  EventState,
  Process,
  Simulation,
  SimulationStats,
} from "./model.ts";

/**
 * Initializes a new simulation instance with:
 * - currentTime set to 0 (starting point of simulation)
 * - empty events array (no scheduled events)
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

    // If the event yielded new events during processing, handle those too
    const nextEvent = finished.generator
      ? handleEvent(sim, finished)
      : finished;

    // Update the simulation's events with the processed event
    sim.events = [...sim.events, nextEvent];
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
 */
export function createEvent(
  sim: Simulation,
  scheduledAt: number,
  callback?: Process,
): Event {
  return {
    id: crypto.randomUUID(),
    status: EventState.Fired,
    firedAt: sim.currentTime,
    scheduledAt,
    callback: callback ?? function* () {
      yield;
    },
  };
}

/**
 * Schedules an event for future processing in the simulation.
 * Validates that the event isn't scheduled in the past.
 * Returns updated events array with the new scheduled event.
 */
export function scheduleEvent(sim: Simulation, event: Event): Event[] {
  if (event.scheduledAt < sim.currentTime) {
    throw RangeError(
      `Event scheduled at a point in time in the past: ${event.id} ` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  return [...sim.events, { ...event, status: EventState.Scheduled }];
}

/**
 * Processes an event by executing its generator function.
 * Handles both immediate completion and yielding of new events.
 * Returns the completed event with updated status and timestamps.
 */
export function handleEvent(sim: Simulation, event: Event): Event {
  // Get the generator - either from previous partial execution or a new one
  const generator = event.generator ?? event.callback(sim, event);
  // Execute next step of the generator
  const { value, done } = generator.next();

  // Remove the original event from the queue
  sim.events = sim.events.filter((previous) => previous.id !== event.id);

  // If generator yielded a value (new event to schedule) and isn't done
  if (!done && value) {
    // Schedule the yielded event and update the current event's generator state
    sim.events = scheduleEvent(sim, {
      ...event,
      scheduledAt: value.scheduledAt,
      generator, // Save generator state for next execution
      callback: function* (_sim: Simulation, _event: Event) {
        yield; // Dummy callback since we're using the generator directly
      },
    });
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
export function* timeout(
  sim: Simulation,
  duration: number,
  callback?: Process,
): Generator<Event | void, void, void> {
  // Fire an event that will be scheduled after specified duration
  const timeoutEvent = createEvent(
    sim,
    sim.currentTime + duration,
    callback,
  );

  // Schedule the timeout event
  sim.events = scheduleEvent(sim, timeoutEvent);

  // Yield control (allowing other code to run until timeout completes)
  yield timeoutEvent;
}
