import type {
  Event,
  EventID,
  EventTransition,
  FilteredGetRequest,
  ProcessState,
  Simulation,
  Store,
  StoreID,
  StoreQueue,
  Timestamp,
} from "./model.ts";
import { EventState } from "./model.ts";

/** Delta operations for events */
type EventDeltaOp = { key: EventID; event: Event };

/** Delta operations for status */
type StatusDeltaOp = { key: EventID; status: EventState };

/** Delta operations for transitions */
type TransitionDeltaOp = { transition: EventTransition };

/** Delta operations for state */
type StateDeltaOp = { key: EventID; value: ProcessState };

/**
 * Delta operations for stores.
 * Only carry the fields that changed.
 */
type StoreDeltaOp = {
  key: StoreID;
  buffer?: StoreQueue;
  getRequests?: StoreQueue;
  putRequests?: StoreQueue;
  filteredGetRequests?: FilteredGetRequest[];
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

/** Full simulation state with delta encoding support */
export interface DeltaEncodedSimulation {
  /** Base snapshot -- full state at reference point */
  base: Simulation;

  /** Sequence of deltas from base to current state */
  deltas: SimulationDelta[];

  /** Current simulation state (can be reconstructed from base + deltas) */
  current: Simulation;
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
    s: diffState(prev.state, current.state),
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
  prev: Record<EventID, EventState>,
  current: Record<EventID, EventState>,
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
 * Uses reference equality per queue field — if references are equal the field is unchanged.
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
    if (!p || p.buffer !== c.buffer) op.buffer = c.buffer;
    if (!p || p.getRequests !== c.getRequests) op.getRequests = c.getRequests;
    if (!p || p.putRequests !== c.putRequests) op.putRequests = c.putRequests;
    if (!p || p.filteredGetRequests !== c.filteredGetRequests) {
      op.filteredGetRequests = c.filteredGetRequests;
    }
    ops.push(op);
  }

  return ops;
}

/**
 * Given a sequence of simulation states, create a delta-encoded representation that captures the initial state as a base and the subsequent states as a series of deltas representing the changes from one state to the next.
 * This allows for efficient storage and reconstruction of the simulation history by only recording the differences between states rather than the full state at each step.
 */
export function createDeltaEncodedSimulation(
  states: Simulation[],
): DeltaEncodedSimulation {
  const base = states[0];
  const deltas = states.slice(1).map((state, index) =>
    createDelta(states[index], state)
  );

  const deltaEncoded = { base, deltas, current: states[states.length - 1] };

  return deltaEncoded;
}

/**
 * Given a base simulation state and a sequence of deltas, reconstruct the full sequence of simulation states by applying each delta in order to the base state.
 */
export function reconstructFromDeltas(
  base: Simulation,
  deltas: SimulationDelta[],
): Simulation[] {
  const states: Simulation[] = [base];
  for (const delta of deltas) {
    states.push(applyDeltas(states[states.length - 1], [delta]));
  }

  return states;
}

/**
 * Applies deltas to `base` and returns only the final state.
 * Use when intermediate states are not needed (e.g. checkpoint resume).
 */
export function applyDeltas(
  base: Simulation,
  deltas: SimulationDelta[],
): Simulation {
  const sim: Simulation = {
    ...base,
    timeline: {
      events: { ...base.timeline.events },
      status: { ...base.timeline.status },
      transitions: [...base.timeline.transitions],
    },
    state: { ...base.state },
    stores: { ...base.stores },
  };
  for (const delta of deltas) {
    sim.currentTime = delta.c;
    for (const op of delta.e) sim.timeline.events[op.key] = op.event;
    for (const op of delta.es) sim.timeline.status[op.key] = op.status;
    for (const op of delta.et) sim.timeline.transitions.push(op.transition);
    for (const op of delta.s) sim.state[op.key] = op.value;
    for (const op of delta.st) {
      const { key, ...fields } = op;
      sim.stores[key] = { ...sim.stores[key], ...fields };
    }
  }
  return sim;
}

/**
 * Prunes finished and unreachable working data after a checkpoint to reduce memory usage mid-run.
 * Full replay remains available through persisted checkpoint files.
 */
export function pruneWorkingState(sim: Simulation): Simulation {
  const events = Object.fromEntries(
    Object.entries(sim.timeline.events).filter(([_id, event]) =>
      sim.timeline.status[event.id] !== EventState.Finished
    ),
  );

  const status = Object.fromEntries(
    Object.entries(sim.timeline.status).filter(([id, status]) =>
      events[id] !== undefined && status !== EventState.Finished
    ),
  );

  const transitions = sim.timeline.transitions.filter((transition) =>
    events[transition.id] !== undefined &&
    status[transition.id] !== EventState.Finished
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
    state: Object.fromEntries(
      Object.entries(sim.state).filter(([id]) => referencedState.has(id)),
    ),
    stores: sim.stores,
  };
}
