import {
  CreateEventOptions,
  Event,
  EventState,
  ProcessDefinition,
  ProcessStep,
  Simulation,
  SimulationStats,
  StateData,
} from "./model.ts";

/**
 * TODO:
 */
export const emptyCallback: ProcessDefinition = {
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

export interface TimeoutData<T extends StateData = StateData>
  extends StateData {
  duration: number;
  callback: string;
  data?: T;
}

/**
 * TODO:
 */
export function registerProcess<T extends StateData>(
  sim: Simulation,
  process: ProcessDefinition<T>,
): Record<string, ProcessDefinition<StateData>> {
  return {
    ...sim.registry,
    [process.type]: process as ProcessDefinition<StateData>,
  };
}

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty events array (no scheduled events)
 * - TODO: Populate process registry
 * - TODO: Empty state array
 */
export function initializeSimulation(): Simulation {
  const sim = {
    currentTime: 0,
    events: [],
    registry: {},
    state: {},
  };

  sim.registry = registerProcess(sim, emptyCallback);

  return sim;
}

/**
 * Inspired by true events:
 * https://oprearocks.medium.com/serializing-object-methods-using-es6-template-strings-and-eval-c77c894651f0
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "function" ? value.toString() : value;
}

function reviver(_key: string, value: unknown): unknown {
  return typeof value === "string" && value.indexOf("function ") === 0
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
function step(sim: Simulation, event: Event<StateData>): Simulation {
  // Advance simulation time to this event's scheduled time
  const nextSim = { ...sim, currentTime: event.scheduledAt };

  // Handle the event by executing its process, which may yield a new event
  const { updated, state, next } = handleEvent(nextSim, event);

  // Update the event's process state in the simulation container
  nextSim.state = { ...nextSim.state, [event.id]: state };

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
 * Processes an event by executing its callback function.
 * Handles both immediate completion and yielding of new events.
 * TODO: Returns the completed event with updated status and timestamps.
 */
function handleEvent(
  sim: Simulation,
  event: Event<StateData>,
): ProcessStep<StateData> {
  // TODO: Retrieve process definition from the registry
  const definition = sim.registry[event.callback];

  // TODO: Get current process state (tied to the parent event) or initialize it
  const parentEvent = sim.events.find(e => e.parent === event.parent);
  const state = event.parent && event.parent in sim.state && event.callback === parentEvent?.callback
    ? { ...sim.state[event.parent] }
    : {
      type: definition.type,
      step: definition.initial,
      data: { ...event.data },
    };

  console.log(`current event: ${event.id} @ ${event.callback}`)
  console.log(`current parent event: ${parentEvent?.id} @ ${parentEvent?.callback}`)
  console.log(`current state step: ${state.step}`)
  console.log(`current definition: ${JSON.stringify(definition)}`)

  // TODO: Get the handler
  const handler = definition.states[state.step];

  // TODO: Execute next step of the process
  const process = handler(sim, event, state);

  // TODO: Schedule process continuation
  if (process.next) {
    // The original process yielded a new event
    // TODO: It means that the event is tied to a process that will be running for at least another step
    // TODO: We store the original event ID into the next event to retrieve process state in the future
    return {
      updated: { ...event },
      state: { ...process.state },
      next: { ...process.next, parent: event.id },
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
    state: { ...process.state },
  };
}

/**
 * Creates a new event with:
 * - Unique ID
 * - TODO: Optional parent event ID (defaults to undefined)
 * - Initial state set to `Fired`
 * - Timestamps for when it was created and scheduled
 * - Optional callback process (defaults to empty callback)
 * - Optional item to carry (defaults to undefined)
 */
export function createEvent<T extends StateData>(
  options: CreateEventOptions<T>,
): Event<T> {
  return {
    ...options,
    id: crypto.randomUUID(),
    status: EventState.Fired,
    firedAt: options.sim.currentTime,
    callback: options.callback ?? "none",
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
): Event<StateData>[] {
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
