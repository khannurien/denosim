import type {
  DisciplineType,
  Event,
  EventID,
  EventTransition,
  GetWhereRequest,
  ProcessState,
  Simulation,
  Store,
  StoreID,
  StoreItemMap,
  StoreQueue,
  Timestamp,
} from "./model.ts";
import { EventStatus } from "./model.ts";

/** Delta operations for events */
export type EventDeltaOp = { key: EventID; event: Event };

/** Delta operations for status */
export type StatusDeltaOp = { key: EventID; status: EventStatus };

/** Delta operations for transitions */
export type TransitionDeltaOp = { transition: EventTransition };

/** Delta operations for state */
export type StateDeltaOp = { key: EventID; value: ProcessState };

/**
 * Delta operations for stores.
 * Only carry the fields that changed.
 */
export type StoreDeltaOp = {
  key: StoreID;
  capacity?: number;
  discipline?: DisciplineType;
  consumerDiscipline?: DisciplineType;
  buffer?: StoreQueue;
  getRequests?: StoreQueue;
  putRequests?: StoreQueue;
  getWhereRequests?: GetWhereRequest[];
};

/** Compact delta representation between simulation states */
export interface SimulationDelta {
  /** Current time */
  c: Timestamp;

  /** Event operations (if any changes) */
  e: EventDeltaOp[];

  /** Event status (if any changes) */
  es: StatusDeltaOp[];

  /** Transition operations (if any changes) */
  et: TransitionDeltaOp[];

  /** State operations (if any changes) */
  s: StateDeltaOp[];

  /** Store operations (if any changes) */
  st: StoreDeltaOp[];
}

/**
 * A window of the history of a run: a state, and the deltas of the events handled from it.
 * The history of a run is a sequence of windows, kept in memory or written to disk, one dump per window.
 */
export interface HistoryWindow<S extends StoreItemMap = StoreItemMap> {
  /** Base snapshot -- state the window starts from */
  base: Simulation<S>;

  /** Sequence of deltas from base, one per handled event */
  deltas: SimulationDelta[];
}

/**
 * Use a diffing algorithm to compare two simulation states and generate a compact delta representation that captures only the changes between them.
 * This allows efficiently storing and transmitting simulation history by avoiding redundant data.
 */
export function createDelta(
  prev: Simulation,
  current: Simulation,
): SimulationDelta {
  return {
    c: current.currentTime,
    e: diffEvents(prev.timeline.events, current.timeline.events),
    es: diffStatus(prev.timeline.status, current.timeline.status),
    et: diffTransitions(
      prev.timeline.transitions,
      current.timeline.transitions,
    ),
    s: diffState(prev.states, current.states),
    st: diffStores(prev.stores, current.stores),
  };
}

/**
 * Algorithm to compute the difference between two event maps, identifying added and modified events based on their unique IDs.
 */
function diffEvents(
  prev: Record<EventID, Event>,
  current: Record<EventID, Event>,
): EventDeltaOp[] {
  const ops: EventDeltaOp[] = [];
  for (const [id, event] of Object.entries(current)) {
    const prevEvent = prev[id];
    if (!prevEvent) {
      ops.push({ key: id, event });
    }
  }

  return ops;
}

function diffStatus(
  prev: Record<EventID, EventStatus>,
  current: Record<EventID, EventStatus>,
): StatusDeltaOp[] {
  const ops: StatusDeltaOp[] = [];
  for (const [id, status] of Object.entries(current)) {
    const prevStatus = prev[id];
    if (prevStatus !== status) {
      ops.push({ key: id, status });
    }
  }

  return ops;
}

/**
 * Algorithm to compute the difference between two transition lists, identifying added transitions based on their ID, state and timestamp.
 */
function diffTransitions(
  prev: EventTransition[],
  current: EventTransition[],
): TransitionDeltaOp[] {
  if (current.length <= prev.length) return [];

  return current.slice(prev.length).map((transition) => ({ transition }));
}

/**
 * Algorithm to compute the difference between two state objects, identifying modified or new process state based on their keys and values.
 * This allows generating a list of operations that can be applied to update the previous state to match the current one, capturing only the necessary changes.
 */
function diffState(
  prev: Record<EventID, ProcessState>,
  current: Record<EventID, ProcessState>,
): StateDeltaOp[] {
  const ops: StateDeltaOp[] = [];

  // Modified or new state
  Object.keys(current).forEach((key) => {
    if (prev[key] === current[key]) return; // Structural sharing: identical reference, skip
    if (
      !prev[key] || JSON.stringify(prev[key]) !== JSON.stringify(current[key])
    ) {
      ops.push({ key, value: current[key] });
    }
  });

  return ops;
}

/**
 * Algorithm to compute the difference between two store objects at field level.
 * Uses reference equality per queue field; if references are equal, the field is unchanged.
 * Only changed fields are included in each op, minimizing serialization cost.
 * Note: stores are never deleted mid-run, so no delete operation is needed or produced.
 */
function diffStores(
  prev: Record<StoreID, Store>,
  current: Record<StoreID, Store>,
): StoreDeltaOp[] {
  const ops: StoreDeltaOp[] = [];

  for (const key of Object.keys(current)) {
    if (prev[key] === current[key]) continue; // Structural sharing: whole store unchanged
    const p = prev[key], c = current[key];
    const op: StoreDeltaOp = { key };
    // A store registered since `prev` (e.g. by a handler) is carried whole
    if (!p || p.capacity !== c.capacity) op.capacity = c.capacity;
    if (!p || p.discipline !== c.discipline) op.discipline = c.discipline;
    if (!p || p.consumerDiscipline !== c.consumerDiscipline) {
      op.consumerDiscipline = c.consumerDiscipline;
    }
    if (!p || p.buffer !== c.buffer) op.buffer = c.buffer;
    if (!p || p.getRequests !== c.getRequests) op.getRequests = c.getRequests;
    if (!p || p.putRequests !== c.putRequests) op.putRequests = c.putRequests;
    if (!p || p.getWhereRequests !== c.getWhereRequests) {
      op.getWhereRequests = c.getWhereRequests;
    }
    ops.push(op);
  }

  return ops;
}

/**
 * Given a sequence of simulation states, create a history window that captures the initial state as a base and the subsequent states as a series of deltas representing the changes from one state to the next.
 * This allows for efficient storage and reconstruction of the simulation history by only recording the differences between states rather than the full state at each step.
 */
export function createHistoryWindow<S extends StoreItemMap>(
  states: Simulation<S>[],
): HistoryWindow<S> {
  const base = states[0];
  const deltas = states.slice(1).map((state, index) =>
    createDelta(states[index], state)
  );

  return { base, deltas };
}

/**
 * Given a base simulation state and a sequence of deltas, reconstruct the full sequence of simulation states by applying each delta in order to the base state.
 */
export function reconstructFromDeltas<S extends StoreItemMap>(
  base: Simulation<S>,
  deltas: SimulationDelta[],
): Simulation<S>[] {
  const states: Simulation<S>[] = [base];
  for (const delta of deltas) {
    states.push(applyDeltas(states[states.length - 1], [delta]));
  }

  return states;
}

/**
 * Applies deltas to `base` and returns only the final state.
 * Use when intermediate states are not needed (e.g. resuming from a dump).
 */
export function applyDeltas<S extends StoreItemMap>(
  base: Simulation<S>,
  deltas: SimulationDelta[],
): Simulation<S> {
  const sim: Simulation<S> = {
    ...base,
    timeline: {
      events: { ...base.timeline.events },
      status: { ...base.timeline.status },
      transitions: [...base.timeline.transitions],
    },
    states: { ...base.states },
  };

  // Stores the deltas change: they are trusted to hold the items the stores of `base` are typed with
  const changed: Record<StoreID, Store> = {};

  for (const delta of deltas) {
    sim.currentTime = delta.c;
    for (const op of delta.e) sim.timeline.events[op.key] = op.event;
    for (const op of delta.es) sim.timeline.status[op.key] = op.status;
    for (const op of delta.et) sim.timeline.transitions.push(op.transition);
    for (const op of delta.s) sim.states[op.key] = op.value;
    for (const op of delta.st) {
      const { key, ...fields } = op;
      changed[key] = { ...(changed[key] ?? base.stores[key]), ...fields };
    }
  }

  return { ...sim, stores: { ...base.stores, ...changed } };
}

/**
 * Prunes finished and unreachable working data after a dump to reduce memory usage mid-run.
 * Full replay remains available through persisted dump files.
 */
export function pruneWorkingState<S extends StoreItemMap>(
  sim: Simulation<S>,
): Simulation<S> {
  const events = Object.fromEntries(
    Object.entries(sim.timeline.events).filter(([_id, event]) =>
      sim.timeline.status[event.id] !== EventStatus.Finished
    ),
  );

  const status = Object.fromEntries(
    Object.entries(sim.timeline.status).filter(([id, status]) =>
      events[id] !== undefined && status !== EventStatus.Finished
    ),
  );

  const transitions = sim.timeline.transitions.filter((transition) =>
    events[transition.id] !== undefined &&
    status[transition.id] !== EventStatus.Finished
  );

  const referencedState = new Set<string>();

  for (const event of Object.values(events)) {
    if (event.parent) referencedState.add(event.parent);
  }

  return {
    ...sim,
    timeline: {
      ...sim.timeline,
      events: { ...events },
      status: { ...status },
      transitions: [...transitions],
    },
    states: Object.fromEntries(
      Object.entries(sim.states).filter(([id]) => referencedState.has(id)),
    ),
    stores: sim.stores,
  };
}

/**
 * Folds a working state into `full`, the complete state accumulated since the start of a run.
 * Events, statuses and states keep the position of their first appearance, i.e. scheduling order.
 * `inherited` is the number of leading transitions of `sim` that `full` already holds: those kept by `pruneWorkingState` for the events still pending.
 * Mutates `full`.
 */
export function absorbWorkingState(
  full: Pick<Simulation, "timeline" | "states">,
  sim: Simulation,
  inherited: number,
): void {
  Object.assign(full.timeline.events, sim.timeline.events);
  Object.assign(full.timeline.status, sim.timeline.status);
  for (const transition of sim.timeline.transitions.slice(inherited)) {
    full.timeline.transitions.push(transition);
  }
  Object.assign(full.states, sim.states);
}

/**
 * Given the history windows of a run, in order, reconstruct the full sequence of simulation states: the base of the first window, then one state per handled event.
 * Every state is complete: it holds every event since the base of the first window, whether the windows were pruned or not.
 * Windows of a run resumed from the result of another can be passed one after the other.
 */
export function historyStates<S extends StoreItemMap>(
  windows: HistoryWindow<S>[],
): Simulation<S>[] {
  const states: Simulation<S>[] = [];

  // Complete state at the end of the windows already replayed
  const full: Pick<Simulation, "timeline" | "states"> = {
    timeline: { events: {}, status: {}, transitions: [] },
    states: {},
  };

  for (const [index, window] of windows.entries()) {
    const replay = reconstructFromDeltas(window.base, window.deltas);

    if (index === 0) {
      // The first window starts from a complete state: its states are complete as they are
      for (const state of replay) states.push(state);
      absorbWorkingState(full, replay[replay.length - 1], 0);
      continue;
    }

    // A later window starts from a working state, whose transitions are already in `full`
    // Its base is skipped: it is the last state of the previous window
    const inherited = window.base.timeline.transitions.length;

    for (const state of replay.slice(1)) {
      // Complete the working state with a copy of what the previous windows hold
      const complete = {
        timeline: {
          events: { ...full.timeline.events },
          status: { ...full.timeline.status },
          transitions: [...full.timeline.transitions],
        },
        states: { ...full.states },
      };
      absorbWorkingState(complete, state, inherited);
      states.push({ ...state, ...complete });
    }

    absorbWorkingState(full, replay[replay.length - 1], inherited);
  }

  return states;
}
