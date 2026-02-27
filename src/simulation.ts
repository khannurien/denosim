import {
  CreateEventOptions,
  Event,
  EventID,
  EventState,
  ProcessDefinition,
  ProcessRegistry,
  ProcessState,
  ProcessStep,
  ProcessType,
  RunSimulationOptions,
  Simulation,
  SimulationStats,
  StateData,
  StepStateMap,
  Timeline,
} from "./model.ts";
import {
  createDelta,
  DeltaEncodedSimulation,
  pruneWorkingState,
  reconstructFullCurrent,
} from "./memory.ts";
import { dumpToDisk, resolveRunContext, shouldDump } from "./runner.ts";
import { serializeSimulation } from "./serialize.ts";

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
  init: Simulation,
  options?: RunSimulationOptions,
): Promise<[Simulation, SimulationStats]> {
  const [sim, stats] = await runSimulationWithDeltas(init, options);

  return [sim.current, stats];
}

/**
 * Runs the simulation and exposes the delta/checkpoint representation.
 * This is intended for persistence, replay, and memory management tooling.
 */
export async function runSimulationWithDeltas(
  init: Simulation,
  options?: RunSimulationOptions,
): Promise<[DeltaEncodedSimulation, SimulationStats]> {
  const runContext = await resolveRunContext(options);
  const dumpInterval = runContext.manifest.dump.interval;

  const start = performance.now();

  const sim: DeltaEncodedSimulation = {
    base: {
      ...init,
    },
    deltas: [],
    current: {
      ...init,
    },
  };
  const checkpoints: string[] = [];

  // Pending is a local hot-path index of Scheduled event IDs, kept outside the model.
  // Initialized from the incoming simulation state; rebuilt after each checkpoint prune.
  let pending = buildPending(sim.current);

  while (true) {
    const [next, nextPending, continuation] = run(sim.current, pending);
    if (!continuation) break;

    pending = nextPending;

    // Memory management: store deltas and dump to disk if necessary
    sim.deltas.push(createDelta(sim.current, next));
    sim.current = next;

    if (shouldDump(sim, dumpInterval)) {
      const checkpoint = await dumpToDisk(
        serializeSimulation(sim),
        sim.current.currentTime,
        runContext,
      );
      checkpoints.push(checkpoint.path);
      const compacted = pruneWorkingState(next);
      sim.base = compacted;
      sim.deltas = [];
      sim.current = compacted;
      pending = buildPending(compacted);
    }

    if (options && shouldTerminate(next, options)) break;
    if (options?.rate) await delay(options.rate);
  }

  const end = performance.now();
  if (checkpoints.length > 0) {
    const current = await reconstructFullCurrent(checkpoints, sim.current);
    // Keep returned delta representation self-consistent
    sim.base = current;
    sim.deltas = [];
    sim.current = current;
  }

  return [
    sim,
    {
      end: sim.current.currentTime,
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
    sim.timeline.status[untilEvent.id] === EventState.Finished;

  return timeMet || eventMet;
}

/**
 * Derives the initial pending set from a simulation state by collecting all event IDs currently in `EventState.Scheduled`.
 * Used to seed the run loop and to rebuild after each checkpoint prune.
 */
function buildPending(sim: Simulation): Set<EventID> {
  return new Set(
    Object.entries(sim.timeline.status)
      .filter(([_, state]) => state === EventState.Scheduled)
      .map(([id]) => id),
  );
}

/**
 * Returns the next simulation state after processing the current event.
 * Returns a boolean indicating whether the simulation should continue.
 * Simulation should continue if there are more events to process in queue.
 */
function run(
  current: Simulation,
  pending: Set<EventID>,
): [Simulation, Set<EventID>, boolean] {
  if (pending.size === 0) {
    return [current, pending, false];
  }

  // Sort descending so we can pop the earliest event
  const sorted = [...pending]
    .map((id) => current.timeline.events[id])
    .sort((a, b) => {
      return a.scheduledAt !== b.scheduledAt
        ? b.scheduledAt - a.scheduledAt
        : b.priority - a.priority;
    });

  const event = sorted.pop()!;
  const next = step(current, event);

  // Maintain pending incrementally: remove processed event, add any newly scheduled ones.
  // New events are those that appear in next but not in current; only Scheduled ones enter pending.
  const nextPending = new Set(pending);
  nextPending.delete(event.id);
  for (const id of Object.keys(next.timeline.events)) {
    if (
      !(id in current.timeline.events) &&
      next.timeline.status[id] === EventState.Scheduled
    ) {
      nextPending.add(id);
    }
  }

  return [next, nextPending, true];
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

  // Finalize the current event: mark as `Finished` and log transition
  nextSim.timeline = finishEvent(nextSim, event);

  // Schedule the next events yielded by the current process if necessary
  // `Waiting` events are not automatically scheduled
  // Allow processes to yield events that are triggered by external conditions or other processes, rather than automatically handled at their scheduled time
  for (const nextEvent of next) {
    nextSim.timeline = scheduleEvent(nextSim, nextEvent);
  }

  // Finish the old events yielded by the current process if necessary
  for (const finishId of finish ?? []) {
    nextSim.timeline = finishEvent(nextSim, sim.timeline.events[finishId]);
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
