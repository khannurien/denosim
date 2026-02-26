import {
  Event,
  EventID,
  EventState,
  EventTransition,
  ProcessState,
  Simulation,
  Store,
  StoreID,
  Timestamp,
} from "./model.ts";
import { deserializeSimulation } from "./serialize.ts";

/** Delta operations for events */
type EventDeltaOp = { op: "set"; key: EventID; event: Event };

/** Delta operations for status */
type StatusDeltaOp = { op: "set"; key: EventID; status: EventState };

/** Delta operations for transitions */
type TransitionDeltaOp = { op: "add"; transition: EventTransition };

/** Delta operations for state */
type StateDeltaOp = { op: "set"; key: EventID; value: ProcessState };

/** Delta operations for stores */
type StoreDeltaOp = { op: "set"; key: StoreID; value: Store };

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
      ops.push({ op: "set", key: id, event });
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
      ops.push({ op: "set", key: id, status });
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

  return current.slice(prev.length).map((transition) => ({
    op: "add",
    transition,
  }));
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
    if (
      !prev[key] || JSON.stringify(prev[key]) !== JSON.stringify(current[key])
    ) {
      ops.push({ op: "set", key, value: current[key] });
    }
  });

  return ops;
}

/**
 * Algorithm to compute the difference between two store objects, identifying modified, new, or deleted stores based on their keys and values.
 * This allows generating a list of operations that can be applied to update the previous stores to match the current ones, capturing only the necessary changes while also handling deletions.
 */
function diffStores(
  prev: Record<StoreID, Store>,
  current: Record<StoreID, Store>,
): StoreDeltaOp[] {
  const ops: StoreDeltaOp[] = [];

  // Modified or new stores
  Object.keys(current).forEach((key) => {
    if (
      !prev[key] || JSON.stringify(prev[key]) !== JSON.stringify(current[key])
    ) {
      ops.push({ op: "set", key, value: current[key] });
    }
  });

  return ops;
}

/**
 * Apply a given delta to a base simulation state to produce an updated simulation state that reflects the changes captured in the delta.
 * This involves processing event operations (additions and updates), state operations (modifications), and store operations (additions, modifications, and deletions) to reconstruct the current simulation state from the base state and the provided delta.
 */
export function applyDelta(
  base: Simulation,
  delta: SimulationDelta,
): Simulation {
  const result: Simulation = {
    ...base,
    currentTime: delta.c,
    timeline: {
      events: { ...base.timeline.events },
      status: { ...base.timeline.status },
      transitions: [...base.timeline.transitions],
    },
    state: { ...base.state },
    stores: { ...base.stores },
  };

  // Apply event operations
  if (delta.e) {
    delta.e.forEach((op) => {
      switch (op.op) {
        case "set":
          result.timeline.events[op.key] = op.event;
          break;
      }
    });
  }

  if (delta.es) {
    delta.es.forEach((op) => {
      switch (op.op) {
        case "set":
          result.timeline.status[op.key] = op.status;
          break;
      }
    });
  }

  if (delta.et) {
    delta.et.forEach((op) => {
      switch (op.op) {
        case "add":
          result.timeline.transitions.push(op.transition);
          break;
      }
    });
  }

  // Apply state operations
  if (delta.s) {
    delta.s.forEach((op) => {
      switch (op.op) {
        case "set":
          result.state[op.key] = op.value;
          break;
      }
    });
  }

  // Apply store operations
  if (delta.st) {
    delta.st.forEach((op) => {
      switch (op.op) {
        case "set":
          result.stores[op.key] = op.value;
          break;
      }
    });
  }

  return result;
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
  return deltas.reduce<Simulation[]>((states, delta) => {
    const previous = states[states.length - 1];
    const current = applyDelta(previous, delta);
    return [...states, current];
  }, [base]);
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

/**
 * Reconstructs a full current state from checkpoint files and an in-memory tail.
 * This restores replay-complete state for run outputs while allowing in-run pruning.
 */
export async function reconstructFullCurrent(
  checkpoints: string[],
  tail: Simulation,
): Promise<Simulation> {
  const snapshots = await Promise.all(
    checkpoints.map(async (checkpoint) => {
      const states = deserializeSimulation(
        await Deno.readTextFile(checkpoint),
        tail.registry,
      );
      return states[states.length - 1];
    }),
  );

  if (snapshots.length === 0) {
    return tail;
  }

  const [first, ...rest] = snapshots;
  const full = rest.reduce(
    (acc, current) => mergeReplayState(acc, current),
    first,
  );

  return mergeReplayState(full, tail);
}

function mergeReplayState(
  previous: Simulation,
  current: Simulation,
): Simulation {
  const eventsById: Record<string, Event> = {
    ...previous.timeline.events,
  };

  for (const [id, event] of Object.entries(current.timeline.events)) {
    eventsById[id] = event;
  }

  const statusById: Record<EventID, EventState> = {
    ...previous.timeline.status,
  };

  for (const [id, status] of Object.entries(current.timeline.status)) {
    statusById[id] = status;
  }

  const transitions = [
    ...previous.timeline.transitions,
    ...current.timeline.transitions,
  ];

  return {
    ...current,
    timeline: {
      ...current.timeline,
      events: eventsById,
      status: statusById,
      transitions,
    },
    state: {
      ...previous.state,
      ...current.state,
    },
  };
}
