import {
  CreateEventOptions,
  Event,
  EventState,
  ProcessDefinition,
  ProcessStep,
  ProcessType,
  Simulation,
  SimulationStats,
  StateData,
  StepStateMap,
} from "./model.ts";

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty events array (no scheduled events)
 * - TODO: Populate process registry
 * - TODO: Empty state array
 */
export function initializeSimulation(): Simulation {
  const emptyProcess: ProcessDefinition<{
    none: StateData;
  }> = {
    type: "none",
    initial: "none",
    states: {
      none(_sim, event, state): ProcessStep {
        return {
          updated: { ...event },
          state: { ...state },
        };
      },
    },
  };

  const sim = {
    currentTime: 0,
    events: [],
    registry: {
      "none": emptyProcess,
    },
    state: {},
  };

  return sim;
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
function step(sim: Simulation, event: Event): Simulation {
  // Advance simulation time to this event's scheduled time
  const nextSim = { ...sim, currentTime: event.scheduledAt };

  // Handle the event by executing its process, which may yield a new event
  // FIXME: Multiple events? (i.e. process next step + callback invocation?)
  const { updated, state, next } = handleEvent(nextSim, event);

  // Update the event's process state in the simulation container
  nextSim.state = { ...nextSim.state, [event.id]: { ...state } };

  // Update the event instance in the event queue if necessary
  nextSim.events = nextSim.events.map((previous) =>
    (previous.id === event.id) ? updated : previous
  );

  // Schedule the next event yielded by the current process if necessary
  if (next) {
    nextSim.events = scheduleEvent(nextSim, next);
  }

  return nextSim;
}

/**
 * Processes an event by executing its associated process if any.
 * TODO: Handles both immediate completion and yielding of new events.
 * TODO: Returns the completed event with updated status and timestamps.
 */
function handleEvent(
  sim: Simulation,
  event: Event,
): ProcessStep {
  // TODO: Retrieve process definition from the registry
  const definition = sim.registry[event.process.type];

  // TODO: Get current process state (tied to the parent event) or initialize it
  const state = event.parent && event.parent in sim.state
    ? { ...sim.state[event.parent] }
    : {
      type: definition.type,
      step: definition.initial,
      data: { ...event.process.data },
    };

  const handler = definition.states[state.step];

  // TODO: Execute next step of the process
  const process = handler(sim, event, state);

  // TODO: If the original process yielded a new event, schedule process continuation
  // FIXME: We could automate setting the `parent` property here:
  // When the event is tied to a process that will be running for at least another step
  // Store the parent event ID into the next event to retrieve process state in the future
  // Otherwise, the event spawns a new process that needs its state initialized
  // Do not store parent event ID, make it a root event
  return {
    updated: {
      ...event,
      finishedAt: sim.currentTime,
      status: EventState.Finished,
    },
    state: { ...process.state },
    // next: process.next ? { ...process.next, parent: event.id } : undefined,
    next: process.next ? { ...process.next } : undefined,
  };
}

/**
 * TODO:
 */
export function registerProcess<
  R extends Record<string, ProcessDefinition<StepStateMap>>,
  S extends StepStateMap,
  K extends ProcessType,
>(
  sim: Simulation<R>,
  process: ProcessDefinition<S> & { type: K },
): R & { [P in K]: ProcessDefinition<S> } {
  return {
    ...sim.registry,
    [process.type]: process,
  };
}

/**
 * Creates a new event with:
 * - Unique ID
 * - TODO: Optional parent event ID (defaults to undefined)
 * - Initial state set to `Fired`
 * - Timestamps for when it was created and scheduled
 * - Optional process to run on event handling (defaults to empty process)
 * - Optional item to carry (defaults to undefined)
 */
export function createEvent<T extends StateData>(
  sim: Simulation,
  options: CreateEventOptions<T>,
): Event<T> {
  return {
    ...options,
    id: crypto.randomUUID(),
    status: EventState.Fired,
    firedAt: sim.currentTime,
    process: options.process ? { ...options.process } : {
      type: "none",
    },
  };
}

/**
 * Schedules an event for future processing in the simulation.
 * Validates that the event isn't scheduled in the past.
 * Returns updated events array with the new scheduled event.
 */
export function scheduleEvent<T extends StateData>(
  sim: Simulation,
  event: Event<T>,
): Event[] {
  if (event.scheduledAt < sim.currentTime) {
    throw RangeError(
      `Event scheduled at a point in time in the past: ${event.id} ` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  return [
    ...sim.events,
    { ...event, status: EventState.Scheduled },
  ];
}
