import {
  CreateEventOptions,
  Event,
  EventState,
  ProcessDefinition,
  ProcessState,
  ProcessStep,
  ProcessType,
  RunSimulationOptions,
  Simulation,
  SimulationStats,
  StateData,
  StepStateMap,
} from "./model.ts";

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty events array (no scheduled events)
 * - Process registry populated with a dummy process (`none`)
 * - Empty state array (no running processes)
 */
export function initializeSimulation(): Simulation {
  const emptyProcess: ProcessDefinition<{
    none: [StateData, []];
  }> = {
    type: "none",
    initial: "none",
    steps: {
      none(_sim, event, state) {
        return {
          updated: { ...event },
          state: { ...state },
          next: [],
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
    stores: {},
  };

  return sim;
}

/**
 * Runs the discrete-event simulation until:
 * - either no more events remain to process;
 * - or the simulation time reaches at least the specified `until` time;
 * - or the simulation reaches a point where the specified `until` event is processed.
 * The simulation processes events in chronological order (earliest first).
 * Playback speed can be adjusted by passing a simulation rate (expressed in Hz).
 * Stores intermediate simulation state (instances) for each event processed.
 * TODO: Publishes states as they go on the optional socket.
 * Checks continuation (events remaining) and termination conditions (i.e. timestamp or event).
 * Returns all the instances along with statistics about the simulation run.
 */
export async function runSimulation(
  sim: Simulation,
  options?: RunSimulationOptions,
): Promise<[Simulation[], SimulationStats]> {
  const start = performance.now();

  const states: Simulation[] = [{ ...sim }];

  while (true) {
    const current = states[states.length - 1];
    const [next, continuation] = run(current);
    states.push(next);

    if (!continuation || (options && shouldTerminate(next, options))) break;
    if (options?.rate) await delay(options.rate);
  }

  const end = performance.now();

  return [
    states,
    {
      end: states[states.length - 1].currentTime,
      duration: end - start,
    },
  ];
}

/**
 * Helper function to introduce a wall-clock delay based on desired simulation rate (in Hz).
 * If rate is not provided, executes immediately.
 * Otherwise, computes delay in milliseconds and times out accordingly.
 */
function delay(rate: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, rate > 0 ? 1000 / rate : 0)
  );
}

/**
 * Helper function to check simulation termination conditions.
 * If `untilTime` is provided, terminates when current time is greater than or equal to `untilTime`.
 * If `untilEvent` is provided, terminates when the event is finished.
 * Always returns false if neither condition is provided.
 */
function shouldTerminate(
  sim: Simulation,
  options: RunSimulationOptions,
): boolean {
  const untilTime = options.untilTime;
  const timeMet = untilTime !== undefined &&
    sim.currentTime >= untilTime;

  const untilEvent = options.untilEvent;
  const eventMet = untilEvent !== undefined &&
    sim.events.find((event) => event.id === untilEvent.id)?.status ===
      EventState.Finished;

  return timeMet || eventMet;
}

/**
 * Returns the next simulation state after processing the current event.
 * Returns a boolean indicating whether the simulation should continue.
 * Simulation should continue if there are more events to process in queue.
 */
function run(current: Simulation): [Simulation, boolean] {
  // Get all scheduled events that haven't been processed yet,
  // sorted in descending order so we can efficiently pop the earliest event
  const pending = current.events.filter((event) =>
    (event.scheduledAt >= current.currentTime) &&
    (event.status === EventState.Scheduled)
  ).sort((a, b) => {
    return a.scheduledAt !== b.scheduledAt
      ? b.scheduledAt - a.scheduledAt
      : b.priority - a.priority
  });

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
 * Updates the event queue with the updated current event.
 * Returns an updated copy of the original simulation container.
 */
function step(sim: Simulation, event: Event): Simulation {
  // Advance simulation time to this event's scheduled time
  const nextSim = { ...sim, currentTime: event.scheduledAt };

  // Handle the event by executing its process, which may yield new events
  const { updated, state, next } = handleEvent(nextSim, event);

  // Update the event's process state in the simulation container
  nextSim.state = { ...nextSim.state, [event.id]: { ...state } };

  // Update the event instance in the event queue if necessary
  nextSim.events = nextSim.events.map((previous) =>
    (previous.id === event.id) ? updated : previous
  );

  // Schedule the next events yielded by the current process if necessary
  for (const nextEvent of next) {
    nextSim.events = scheduleEvent(nextSim, nextEvent);
  }

  return nextSim;
}

/**
 * Processes an event by executing its associated process, if any.
 * Handles both immediate completion and yielding of new events.
 * Returns the intermediate state for the completed simulation step:
 * - Handled event with updated status and timestamps;
 * - Updated state for the process associated to the event;
 * - Optional next events (for multi-step processes and/or spawning new processes).
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

  // Get current process state:
  // - either from multi-step continuation: copy previous state and override with updated state;
  // - TODO: fork/exec
  // - or tied to the parent event: copy parent state and override with child state;
  // - or initialize it from process definition in case of a first run.
  const state: ProcessState = event.id in sim.state
    ? {
      ...sim.state[event.id],
      data: {
        ...sim.state[event.id].data,
        ...event.process.data,
      },
    }
    : parentState && event.process.inheritStep &&
        parentState.type === event.process.type
    ? {
      type: definition.type,
      step: parentState.step,
      data: {
        ...parentState.data,
        ...event.process.data,
      },
    }
    : parentState
    ? {
      type: definition.type,
      step: definition.initial,
      data: {
        ...parentState.data,
        ...event.process.data,
      },
    }
    : {
      type: definition.type,
      step: definition.initial,
      data: { ...event.process.data },
    };

  // Retrieve the process handler according to the state
  const handler = definition.steps[state.step];

  // Execute next step of the process
  const process = handler(sim, event, state);

  // If the process did not progress, it means it is finished
  // Legitimate loops should use parent-child event semantics
  return process.state.step !== state.step
    ? {
      ...process,
      updated: {
        ...process.updated,
      },
    }
    : {
      ...process,
      updated: {
        ...process.updated,
        status: EventState.Finished,
        finishedAt: sim.currentTime,
      },
    };
}

/**
 * Registers a process for further use during simulation.
 * Processes are spawned on event handling (see `CreateEventOptions`).
 * Returns the updated process registry.
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
 * Returns a new event with:
 * - Unique ID
 * - Optional parent event ID (defaults to `undefined`)
 * - Initial event state set to `Fired`
 * - TODO: Priority
 * - Timestamps for when it was created and scheduled
 * - Optional process to run on event handling (defaults to `none`, the dummy process)
 */
export function createEvent<T extends StateData>(
  sim: Simulation,
  options: CreateEventOptions<T>,
): Event<T> {
  return {
    ...options,
    id: crypto.randomUUID(),
    status: EventState.Fired,
    priority: options.priority ?? 0,
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
