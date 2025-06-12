import {
  Event,
  EventState,
  ProcessDefinition,
  ProcessStep,
  ProcessType,
  Simulation,
  SimulationStats,
} from "./model.ts";

/**
 * TODO:
 */
export const emptyCallback: ProcessDefinition<void, void> = {
  type: "none",
  initial: "none",
  states: {
    none(_sim, event, state): ProcessStep<void, void> {
      return {
        updated: {...event},
        state: {...state},
      }
    }
  }
}

/**
 * TODO:
 */
export function registerProcess(sim: Simulation, process: ProcessDefinition<unknown, unknown>): Record<string, ProcessDefinition<unknown, unknown>> {
  return {
    ...sim.registry,
    [process.type]: process,
  }
}

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty events array (no scheduled events)
 * - TODO: Populate process registry
 * - TODO: Empty state array
 */
export function initializeSimulation(): Simulation {
  return {
    currentTime: 0,
    events: [],
    registry: {
      [emptyCallback.type]: emptyCallback as ProcessDefinition<unknown, unknown>,
    },
    state: {},
  };
}

/**
 * Inspired by true events:
 * https://oprearocks.medium.com/serializing-object-methods-using-es6-template-strings-and-eval-c77c894651f0
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof(value) === "function"
    ? value.toString()
    : value;
}

function reviver(_key: string, value: unknown): unknown {
  return typeof(value) === "string" && value.indexOf("function ") === 0
    ? eval(`(${value})`)
    : value;
}

/**
 * TODO:
 */
export function serializeSimulation(sim: Simulation): string {
  return JSON.stringify(sim, replacer, 2);
}

/**
 * TODO:
 */
export function deserializeSimulation(data: string): Simulation {
  return JSON.parse(data, reviver);
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
function step(sim: Simulation, event: Event<unknown>): Simulation {
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
 * Processes an event by executing its callback function.
 * Handles both immediate completion and yielding of new events.
 * TODO: Returns the completed event with updated status and timestamps.
 */
function handleEvent(
  sim: Simulation,
  event: Event<unknown>,
): ProcessStep<unknown, unknown> {
  // TODO: Get current process state or initialize it
  const definition = sim.registry[event.callback];
  // FIXME: event.item?
  const state = sim.state[event.id] ?? {
    type: definition.type,
    step: definition.initial,
    data: event.item,
  };
  console.log("from scheduler:", event.item);
  const step = state?.step ?? definition.initial;

  // FIXME: Initialize process state?
  // if (!state) ...

  // TODO: Get the handler
  const handler = definition.states[step];

  // TODO: Execute next step of the process
  const process = handler(sim, event, state);

  // TODO: Schedule process continuation
  if (process.next) {
    // The original process yielded a new event
    // We will wait for that new event to be handled before continuing the original event
    // Return the event updated with continuation metadata along with its current state
    // Return the new event to be scheduled
    return process.next.id !== event.id
      ? {
        updated: {
          ...event,
          // Synchronization between original process end and yielded process start
          // TODO: Still necessary/desirable?
          scheduledAt: process.next.scheduledAt,
        },
        state: process.state,
        next: process.next,
      }
      : {
        updated: {...process.next},
        state: process.state,
      }
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
    state: process.state,
  };
}

/**
 * Creates a new event with:
 * - Unique ID
 * - Initial state set to `Fired`
 * - Timestamps for when it was created and scheduled
 * - Optional callback process (defaults to empty callback)
 * - Optional item to carry (defaults to undefined)
 */
export function createEvent<T>(
  sim: Simulation,
  scheduledAt: number,
  callback?: ProcessType,
  item?: T,
): Event<T> {
  return {
    id: crypto.randomUUID(),
    status: EventState.Fired,
    firedAt: sim.currentTime,
    scheduledAt,
    callback: callback ?? "none",
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
