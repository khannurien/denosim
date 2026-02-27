import {
  CreateEventOptions,
  Event,
  EventState,
  ProcessDefinition,
  ProcessRegistry,
  ProcessState,
  ProcessStep,
  ProcessType,
  RunSimulationOptions,
  Simulation,
  StateData,
  StepStateMap,
  Timeline,
} from "./model.ts";

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty timeline (no initial events)
 * - Process registry populated with a dummy process (`none`)
 * - Empty state array (no running processes)
 */
export function initializeSimulation(): Simulation {
  const sim = {
    currentTime: 0,
    timeline: {
      events: {},
      status: {},
      transitions: [],
    },
    registry: {},
    state: {},
    stores: {},
  };

  const emptyProcess: ProcessDefinition<{
    none: StateData;
  }> = {
    type: "none",
    initial: "none",
    steps: {
      none(_sim, _event, state) {
        return {
          state: state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, emptyProcess);

  return sim;
}

/**
 * Helper function to check simulation termination conditions.
 * If `untilTime` is provided, terminates when current time is greater than or equal to `untilTime`.
 * If `untilEvent` is provided, terminates when the event is finished.
 * Always returns false if neither condition is provided.
 */
export function shouldTerminate(
  sim: Simulation,
  options: RunSimulationOptions,
): boolean {
  const untilTime = options.untilTime;
  const timeMet = untilTime !== undefined &&
    sim.currentTime >= untilTime;

  const untilEvent = options.untilEvent;
  const eventMet = untilEvent !== undefined &&
    sim.timeline.status[untilEvent.id] === EventState.Finished;

  return timeMet || eventMet;
}

/**
 * Returns the next simulation state after processing the current event.
 * Returns a boolean indicating whether the simulation should continue.
 * Simulation should continue if there are more events to process in queue.
 */
export function run(current: Simulation): [Simulation, boolean] {
  // Get all scheduled events that haven't been processed yet,
  // sorted in descending order so we can efficiently pop the earliest event
  const pending = Object.values(current.timeline.events).filter((event) =>
    (event.scheduledAt >= current.currentTime) &&
    (current.timeline.status[event.id] === EventState.Scheduled)
  ).sort((a, b) => {
    return a.scheduledAt !== b.scheduledAt
      ? b.scheduledAt - a.scheduledAt
      : b.priority - a.priority;
  });

  // The global event queue is not modified in place
  const event = pending.pop();

  if (!event) {
    return [current, false]; // No more events to process
  }

  const next = step(current, event);

  return [next, true];
}

/**
 * Processes the simulation for one step, i.e. handles the current event,
 * and possibly schedules a next one.
 * Advances the simulation time to the current event scheduled time.
 * Updates the state of the process associated with the current event.
 * Updates the event queue with the current event marked as `Finished`.
 * Returns an updated copy of the original simulation container.
 */
function step(sim: Simulation, event: Event): Simulation {
  // Advance simulation time to this event's scheduled time
  const nextSim: Simulation = {
    ...sim,
    currentTime: event.scheduledAt,
    timeline: {
      events: { ...sim.timeline.events },
      status: { ...sim.timeline.status },
      transitions: [...sim.timeline.transitions],
    },
    state: { ...sim.state },
    stores: Object.fromEntries(
      Object.entries(sim.stores).map(([id, store]) => [
        id,
        {
          ...store,
          buffer: [...store.buffer],
          getRequests: [...store.getRequests],
          putRequests: [...store.putRequests],
        },
      ]),
    ),
  };

  // Handle the event by executing its process, which may yield new events to schedule and old events to finish
  const { state, next, finish } = handleEvent(nextSim, event);

  // Update the event's process state in the simulation container
  nextSim.state[event.id] = { ...state };

  // Mark the event as finished and append a lifecycle transition
  nextSim.timeline = finishEvent(nextSim, event);

  // Schedule the next events yielded by the current process if necessary
  // `Waiting` events are not automatically scheduled. This allows processes to yield events that are triggered by external conditions or other processes, rather than automatically handled at their scheduled time.
  for (const nextEvent of next) {
    nextSim.timeline = scheduleEvent(nextSim, nextEvent);
  }

  // Finish the old events yielded by the current process
  for (const finishedEvent of finish ?? []) {
    nextSim.timeline = finishEvent(nextSim, finishedEvent);
  }

  return nextSim;
}

/**
 * Handles an event by executing its associated process.
 * Returns the intermediate result for the completed simulation step:
 * - Handled event with updated status and timestamps reflecting process state;
 * - Updated state for the process associated to the event;
 * - Optional next events for process continuation or spawning new processes.
 */
function handleEvent(
  sim: Simulation,
  event: Event,
): ProcessStep {
  // Retrieve process definition from the registry
  const definition = sim.registry[event.process.type];

  // Retrieve parent process state if it exists
  const parentState = event.parent && event.parent in sim.state
    ? sim.state[event.parent]
    : undefined;

  // Get current process state
  const state: ProcessState =
    // PROCESS CONTINUATION with state inheritance (UNIX `fork`)
    // Child event explicitly continues parent's process instance.
    // This creates true process continuation where:
    // - Child events continue parent's exact execution point
    // - The same process instance advances through multiple events
    // Used for temporal patterns (timeouts), synchronous I/O (synchronization).
    (
        parentState && event.process.inheritStep &&
        parentState.type === event.process.type
      )
      ? {
        type: parentState.type,
        step: parentState.step,
        data: {
          ...parentState.data,
          ...event.process.data,
        },
      }
      // NEW PROCESS with data inheritance (UNIX `fork`/`exec`)
      // Child starts a new process instance but inherits parent's data.
      // This creates related but independent processes:
      // - Parent spawning worker processes with shared context
      // - Main process creating sub-processes with initialization data
      // - Any parent-child relationship where data flows downstream
      : parentState
      ? {
        type: definition.type,
        step: definition.initial,
        data: {
          ...parentState.data,
          ...event.process.data,
        },
      }
      // BRAND NEW PROCESS (UNIX `execve`)
      // Completely new process with no parent relationship.
      // Process state initialized from process definition.
      // This is the entry point for:
      // - Initial events scheduled in the simulation
      // - External triggers starting new workflows
      // - Root processes with no dependencies
      : {
        type: definition.type,
        step: definition.initial,
        data: { ...event.process.data },
      };

  // Retrieve process step handler according to the process state
  const handler = definition.steps[state.step];

  // Execute next step of the process
  return handler(sim, event, { ...state });
}

/**
 * Registers a process for further use during simulation.
 * Processes are spawned on event handling (see `CreateEventOptions`).
 * Returns the updated process registry.
 */
export function registerProcess<
  R extends ProcessRegistry,
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
 * Returns a new event with:
 * - Unique ID
 * - Optional parent event ID (defaults to `undefined`)
 * - Initial event status optionally set to `Waiting`
 * - An optional priority value (the lower the value, the higher the priority; defaults to 0)
 * - Scheduled timestamp
 * - Optional process to run on event handling (defaults to `none`, the dummy process)
 */
export function createEvent<T extends StateData>(
  options: CreateEventOptions<T>,
): Event<T> {
  return {
    id: crypto.randomUUID(),
    parent: options.parent,
    waiting: options.waiting,
    priority: options.priority ?? 0,
    scheduledAt: options.scheduledAt,
    process: options.process ? { ...options.process } : {
      type: "none",
    },
  };
}

/**
 * Schedules an event for future processing in the simulation.
 * Validates that the event isn't scheduled in the past.
 * `initialState` defaults to `EventState.Scheduled` unless `waiting` specificed at event creation when expected to block until explicitly resumed (through e.g. store synchronization primitives).
 * Returns an updated Timeline reflecting the new event and its initial transition.
 */
export function scheduleEvent<T extends StateData>(
  sim: Simulation,
  event: Event<T>,
): Timeline {
  if (event.scheduledAt < sim.currentTime) {
    throw RangeError(
      `Event scheduled at a point in time in the past: ${event.id} ` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  const initialState: EventState = event.waiting
    ? EventState.Waiting
    : EventState.Scheduled;

  return {
    ...sim.timeline,
    events: { ...sim.timeline.events, [event.id]: { ...event } },
    status: {
      ...sim.timeline.status,
      [event.id]: initialState,
    },
    transitions: [
      ...sim.timeline.transitions,
      { id: event.id, state: initialState, at: sim.currentTime },
    ],
  };
}

export function finishEvent<T extends StateData>(
  sim: Simulation,
  event: Event<T>,
): Timeline {
  return {
    ...sim.timeline,
    status: { ...sim.timeline.status, [event.id]: EventState.Finished },
    transitions: [
      ...sim.timeline.transitions,
      { id: event.id, state: EventState.Finished, at: sim.currentTime },
    ],
  };
}
