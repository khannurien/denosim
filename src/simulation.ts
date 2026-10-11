import type {
  CreateEventOptions,
  DisciplineDefinition,
  DisciplineRegistry,
  DisciplineType,
  Event,
  PredicateDefinition,
  PredicateRegistry,
  PredicateType,
  ProcessDefinition,
  ProcessRegistry,
  ProcessState,
  ProcessType,
  Simulation,
  StateData,
  StepResult,
  StepStateMap,
  StoreItemMap,
  Timeline,
  Timestamp,
} from "./model.ts";
import { EventStatus, QueueDiscipline } from "./model.ts";
import { type EventHeap, heapPeek, heapPop } from "./heap.ts";

/**
 * Initializes a new simulation instance with:
 * - `currentTime` set to 0 (starting point of simulation)
 * - Empty timeline (no initial events)
 * - Process registry populated with a dummy process (`none`)
 * - Discipline registry pre-populated with `FIFO` and `LIFO`
 * - Empty predicate registry
 * - Empty state (no handled events)
 */
export function initializeSimulation(): Simulation {
  const sim: Simulation = {
    currentTime: 0,
    timeline: {
      events: {},
      status: {},
      transitions: [],
    },
    processes: {},
    disciplines: {},
    predicates: {},
    states: {},
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

  sim.processes = registerProcess(sim, emptyProcess);

  const fifoDiscipline: DisciplineDefinition = {
    type: QueueDiscipline.FIFO,
    comparator: (a, b) => a.seq - b.seq,
  };

  const lifoDiscipline: DisciplineDefinition = {
    type: QueueDiscipline.LIFO,
    comparator: (a, b) => b.seq - a.seq,
  };

  sim.disciplines = registerDiscipline(sim, fifoDiscipline);
  sim.disciplines = registerDiscipline(sim, lifoDiscipline);

  return sim;
}

/**
 * Returns the earliest scheduled event, without handling it.
 * Drops from the heap the events finished since they were pushed.
 * Returns `undefined` if there are no more events to process in queue.
 */
export function nextEvent(
  current: Simulation,
  heap: EventHeap,
): Event | undefined {
  while (true) {
    const entry = heapPeek(heap);

    if (!entry) {
      return undefined; // No more events to process
    }

    // Only handle `Scheduled` events: lazily skip those finished since they were pushed
    if (current.timeline.status[entry.id] === EventStatus.Scheduled) {
      return current.timeline.events[entry.id];
    }

    heapPop(heap);
  }
}

/**
 * Returns the next simulation state after processing the earliest scheduled event.
 * Returns a boolean indicating whether the simulation should continue.
 * Simulation should continue if there are more events to process in queue.
 */
export function advance(
  current: Simulation,
  heap: EventHeap,
): [Simulation, boolean] {
  const event = nextEvent(current, heap);

  if (!event) {
    return [current, false]; // No more events to process
  }

  heapPop(heap);

  return [handleEvent(current, event), true];
}

/**
 * Handles the current event, and possibly schedules next ones.
 * Advances the simulation time to the current event scheduled time.
 * Updates the state of the process associated with the current event.
 * Updates the event queue with the current event marked as `Finished`.
 * Returns an updated copy of the original simulation container.
 */
function handleEvent(sim: Simulation, event: Event): Simulation {
  // Advance simulation time to this event's scheduled time
  // Start with a shallow copy of the timeline; finishEvent and scheduleEvent will do deep copies
  // Shallow-copy the stores registry; store objects are copied on write by put/get
  const nextSim: Simulation = {
    ...sim,
    currentTime: event.scheduledAt,
    states: { ...sim.states },
    stores: { ...sim.stores },
  };

  // Handle the event by executing its process, which may yield new events to schedule and old events to finish
  const { state, next, finish } = runStep(nextSim, event);

  // Update the event's process state in the simulation container
  nextSim.states[event.id] = { ...state };

  // Mark the events as finished and append a lifecycle transition
  const finished = finish ? [...finish, event] : [event];
  for (const finishedEvent of finished) {
    nextSim.timeline = finishEvent(nextSim, finishedEvent);
  }

  // Schedule the next events yielded by the current process if necessary
  // `Waiting` events are added to the timeline but never handled: they stand for a blocked process until another step finishes them and emits its continuation.
  for (const nextEvent of next) {
    nextSim.timeline = scheduleEvent(nextSim, nextEvent);
  }

  return nextSim;
}

/**
 * Runs the process step associated with an event.
 * Returns the step result:
 * - Updated state for the process associated to the event;
 * - Optional next events for process continuation or spawning new processes.
 */
function runStep(
  sim: Simulation,
  event: Event,
): StepResult {
  // Retrieve process definition from the registry
  const definition = sim.processes[event.process.type];
  if (!definition) {
    throw new RangeError(
      `Process definition not found in registry: ${event.process.type}`,
    );
  }

  // Retrieve parent process state if the event has a parent
  const parentState = event.parent ? sim.states[event.parent] : undefined;
  if (event.parent && !parentState) {
    throw new RangeError(
      `Parent state not found for event: ${event.id} (parent: ${event.parent})`,
    );
  }

  // A continuation needs a parent to continue from
  if (event.process.continues && !event.parent) {
    throw new TypeError(
      `Event cannot continue a process without a parent: ${event.id}`,
    );
  }

  // A process can only be continued under its own type
  if (
    parentState && event.process.continues &&
    parentState.type !== event.process.type
  ) {
    throw new TypeError(
      `Event cannot continue a process of another type: ${event.id}` +
        ` (process: ${event.process.type}; parent process: ${parentState.type})`,
    );
  }

  // Get current process state
  const state: ProcessState =
    // CONTINUATION with state inheritance
    // Child event explicitly continues parent's process.
    // This creates true process continuation where:
    // - Child events continue parent's exact execution point
    // - The same process advances through multiple events, keeping its ID
    // Several continuations emitted from the same step each get their own copy of the state (UNIX `fork`).
    // Used for temporal patterns (timeouts), synchronous I/O (synchronization).
    (parentState && event.process.continues)
      ? {
        id: parentState.id,
        ...(parentState.spawner && { spawner: parentState.spawner }),
        type: parentState.type,
        step: parentState.step,
        data: {
          ...parentState.data,
          ...event.process.data,
        },
      }
      // SPAWN: new process with data inheritance (UNIX `posix_spawn`, i.e. `fork` then `exec`)
      // Child starts a new process instance, with its own ID, but inherits parent's data.
      // This creates related but independent processes:
      // - Parent spawning worker processes with shared context
      // - Main process creating sub-processes with initialization data
      // - Any parent-child relationship where data flows downstream
      : parentState
      ? {
        id: event.id,
        spawner: parentState.id,
        type: definition.type,
        step: definition.initial,
        data: {
          ...parentState.data,
          ...event.process.data,
        },
      }
      // ROOT PROCESS (no UNIX equivalent; closest to `init`)
      // Completely new process with no parent relationship.
      // Process state initialized from process definition.
      // This is the entry point for:
      // - Initial events scheduled in the simulation
      // - External triggers starting new workflows
      // - Root processes with no dependencies
      : {
        id: event.id,
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
 * Registers a discipline definition in the simulation's discipline registry.
 * Returns the updated discipline registry.
 */
export function registerDiscipline<
  T extends StateData = StateData,
  K extends DisciplineType = DisciplineType,
>(
  sim: Simulation,
  discipline: DisciplineDefinition<K, T>,
): DisciplineRegistry {
  return {
    ...sim.disciplines,
    [discipline.type]: discipline,
  } as DisciplineRegistry;
}

/**
 * Registers a predicate function for use with `getWhere`.
 * Returns the updated predicate registry.
 */
export function registerPredicate<
  T extends StateData = StateData,
  K extends PredicateType = PredicateType,
>(
  sim: Simulation,
  definition: PredicateDefinition<T, K>,
): PredicateRegistry {
  return {
    ...sim.predicates,
    [definition.type]: definition.predicate,
  } as PredicateRegistry;
}

/**
 * Registers a process for further use during simulation.
 * Processes are spawned on event handling (see `CreateEventOptions`).
 * Returns the updated process registry.
 */
export function registerProcess<
  M extends StepStateMap,
  K extends ProcessType,
  S extends StoreItemMap = StoreItemMap,
>(
  sim: Simulation,
  process: ProcessDefinition<M, S> & { type: K },
): ProcessRegistry {
  return {
    ...sim.processes,
    [process.type]: process,
  } as ProcessRegistry;
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
 * Advances `event` to its next step, at `scheduledAt`. `event.id` becomes the parent of the new event.
 * Pass `data` to attach a payload, merged over the process data on the next step; without it, the next step sees the state returned by the handler as is.
 * Use `options` to set `waiting`, `priority`, etc.
 */
export function continueEvent<T extends StateData>(
  event: Event,
  scheduledAt: Timestamp,
  data?: T,
  options?: Pick<CreateEventOptions, "waiting" | "priority">,
): Event<T> {
  return createEvent({
    parent: event.id,
    scheduledAt,
    ...options,
    process: data !== undefined
      ? { type: event.process.type, continues: true, data: { ...data } }
      : { type: event.process.type, continues: true },
  });
}

/**
 * Resumes the process blocked on a waiting event, at `scheduledAt`. `blocked.parent` becomes the parent of the new event.
 * Used when a producer delivers to a blocked consumer, or vice-versa: the blocked event provides the process step to resume.
 * Pass `data` to deliver a payload (an item to a blocked consumer); without it, the resumed step sees the state returned by the handler as is (a blocked producer).
 */
export function resumeEvent<T extends StateData>(
  blocked: Event<StateData>,
  scheduledAt: Timestamp,
  data?: T,
  options?: Pick<CreateEventOptions, "priority">,
): Event<T> {
  return createEvent({
    parent: blocked.parent,
    scheduledAt,
    ...options,
    process: data !== undefined
      ? { type: blocked.process.type, continues: true, data: { ...data } }
      : { type: blocked.process.type, continues: true },
  });
}

/**
 * Schedules an event for future processing in the simulation.
 * Validates that the event isn't scheduled in the past.
 * `initialStatus` defaults to `EventStatus.Scheduled` unless `waiting` is specified at event creation, in which case the event is never handled (see `EventStatus.Waiting`).
 * Returns an updated Timeline reflecting the new event and its initial transition.
 */
export function scheduleEvent<T extends StateData>(
  sim: Simulation,
  event: Event<T>,
): Timeline {
  if (event.scheduledAt < sim.currentTime) {
    throw RangeError(
      `Event scheduled at a point in time in the past: ${event.id}` +
        ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  const initialStatus: EventStatus = event.waiting
    ? EventStatus.Waiting
    : EventStatus.Scheduled;

  return {
    ...sim.timeline,
    events: { ...sim.timeline.events, [event.id]: event },
    status: {
      ...sim.timeline.status,
      [event.id]: initialStatus,
    },
    transitions: [
      ...sim.timeline.transitions,
      { id: event.id, status: initialStatus, at: sim.currentTime },
    ],
  };
}

/**
 * Closes an event's lifecycle in the timeline by marking it `Finished`.
 * Because the timeline is append-only and events are never deleted, this signals completion and excludes the event from future scheduling.
 * Returns an updated Timeline with the event's status marked as `Finished` and the corresponding transition appended; an event that is already `Finished` is left as is.
 */
export function finishEvent<T extends StateData>(
  sim: Simulation,
  event: Event<T>,
): Timeline {
  // Already finished: nothing to record
  if (sim.timeline.status[event.id] === EventStatus.Finished) {
    return sim.timeline;
  }

  return {
    ...sim.timeline,
    status: { ...sim.timeline.status, [event.id]: EventStatus.Finished },
    transitions: [
      ...sim.timeline.transitions,
      { id: event.id, status: EventStatus.Finished, at: sim.currentTime },
    ],
  };
}
