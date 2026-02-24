import {
  Event,
  EventID,
  ProcessState,
  Simulation,
  Store,
  StoreID,
  Timestamp,
} from "./model.ts";

/** Delta operations for events */
type EventDeltaOp =
  | { op: "add"; event: Event }
  | { op: "update"; id: EventID; event: Event };

/** Delta operations for state */
type StateDeltaOp = { op: "set"; key: EventID; value: ProcessState };

/** Delta operations for stores */
type StoreDeltaOp =
  | { op: "set"; key: StoreID; value: Store }
  | { op: "delete"; key: StoreID };

/** Compact delta representation between simulation states */
export interface SimulationDelta {
  /** Current time */
  t: Timestamp;

  /** Event operations (if any changes) */
  e: EventDeltaOp[];

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
    t: current.currentTime,
    e: diffEvents(prev.events, current.events),
    s: diffState(prev.state, current.state),
    st: diffStores(prev.stores, current.stores),
  };
}

/**
 * Algorithm to compute the difference between two arrays of events, identifying added and modified events based on their unique IDs.
 * This allows generating a list of operations that can be applied to transform the previous event list into the current one, capturing only the necessary changes.
 */
function diffEvents(prev: Event[], current: Event[]): EventDeltaOp[] {
  const ops: EventDeltaOp[] = [];
  const prevMap = new Map(prev.map((e) => [e.id, e]));

  // Find new events
  // TODO: current[previous.length] -> current.length - 1
  current.forEach((event) => {
    if (!prevMap.has(event.id)) {
      ops.push({ op: "add", event });
    }
  });

  // Find modified events
  current.forEach((event) => {
    const prevEvent = prevMap.get(event.id);
    if (prevEvent && JSON.stringify(prevEvent) !== JSON.stringify(event)) {
      ops.push({ op: "update", id: event.id, event });
    }
  });

  return ops;
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

  // Removed stores
  Object.keys(prev).forEach((key) => {
    if (!current[key]) {
      ops.push({ op: "delete", key });
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
    currentTime: delta.t,
    events: [...base.events],
    state: { ...base.state },
    stores: { ...base.stores },
  };

  // Apply event operations
  if (delta.e) {
    delta.e.forEach((op) => {
      switch (op.op) {
        case "add":
          result.events.push(op.event);
          break;
        case "update": {
          const eventIndex = result.events.findIndex((e) => e.id === op.id);
          if (eventIndex !== -1) {
            result.events[eventIndex] = op.event;
          }
          break;
        }
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
        case "delete":
          delete result.stores[op.key];
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
  const deltas: SimulationDelta[] = [];

  for (let i = 1; i < states.length; i++) {
    deltas.push(createDelta(states[i - 1], states[i]));
  }

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

  for (let i = 0; i < deltas.length; i++) {
    // Use the previous state in the reconstructed array
    const state = states[i];
    const delta = deltas[i];

    const current = applyDelta(state, delta);

    states.push(current);
  }

  return states;
}
