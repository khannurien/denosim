import {
  Event,
  EventID,
  ProcessState,
  Simulation,
  Store,
  StoreID,
  Timestamp,
} from "./model.ts";
import { serializeSimulation } from "./serialize.ts";

/**
 * TODO:
 */
export function shouldDump(
  sim: Simulation,
): boolean {
  return sim.events.length - sim.dump.state.last >= sim.dump.config.interval;
}

/**
 * TODO:
 */
export async function dumpToDisk(
  states: Simulation[],
): Promise<Simulation> {
  const sim = states[states.length - 1];

  const dumpPath =
    `${sim.dump.config.directory}/full-dump-${sim.dump.state.count}.json`;

  // TODO: Persist all current simulation history
  const serialized = serializeSimulation(states);
  await Deno.writeTextFile(dumpPath, serialized);

  console.log(
    `[${sim.currentTime} Dumped ${sim.events.length} events to ${dumpPath}`,
  );

  const recentEvents = sim.events.slice(-sim.dump.config.keep);
  const recentEventIds = new Set(recentEvents.map((e) => e.id));
  const recentState = Object.fromEntries(
    Object.entries(sim.state).filter(([id]) => recentEventIds.has(id)),
  );

  const dumpedSim: Simulation = {
    ...sim,
    events: recentEvents,
    state: recentState,
    stores: sim.stores,
    dump: {
      config: sim.dump.config,
      state: {
        count: sim.dump.state.count + 1,
        last: recentEvents.length,
      },
    },
  };

  return dumpedSim;
}

/** Delta operations for events */
type EventDeltaOp =
  | { op: "add"; event: Event }
  | { op: "update"; id: EventID; event: Event }
  | { op: "remove"; id: EventID };

/** Delta operations for state */
type StateDeltaOp =
  | { op: "set"; key: EventID; value: ProcessState }
  | { op: "delete"; key: EventID };

/** Delta operations for stores */
type StoreDeltaOp =
  | { op: "set"; key: StoreID; value: Store }
  | { op: "delete"; key: StoreID };

/** Compact delta representation between simulation states */
export interface SimulationDelta {
  /** Current time */
  t: Timestamp;

  /** Event operations (if any changes) */
  e?: EventDeltaOp[];

  /** State operations (if any changes) */
  s?: StateDeltaOp[];

  /** Store operations (if any changes) */
  st?: StoreDeltaOp[];
}

/** Full simulation state with delta encoding support */
export interface DeltaEncodedSimulation {
  /** Base snapshot - full state at reference point */
  base: Simulation;
  /** Sequence of deltas from base to current state */
  deltas: SimulationDelta[];
}

// Add these utility functions

export function createDelta(prev: Simulation, current: Simulation): SimulationDelta {
  const delta: SimulationDelta = { t: current.currentTime };

  // Diff events
  const eventOps = diffEvents(prev.events, current.events);
  if (eventOps.length > 0) delta.e = eventOps;

  // Diff state
  const stateOps = diffState(prev.state, current.state);
  if (stateOps.length > 0) delta.s = stateOps;

  // Diff stores
  const storeOps = diffStores(prev.stores, current.stores);
  if (storeOps.length > 0) delta.st = storeOps;

  return delta;
}

function diffEvents(prev: Event[], current: Event[]): EventDeltaOp[] {
  const ops: EventDeltaOp[] = [];
  const prevMap = new Map(prev.map((e) => [e.id, e]));
  const currentMap = new Map(current.map((e) => [e.id, e]));

  // Find new events
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

  // Find removed events
  prev.forEach((event) => {
    if (!currentMap.has(event.id)) {
      ops.push({ op: "remove", id: event.id });
    }
  });

  return ops;
}

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

  // Removed state
  Object.keys(prev).forEach((key) => {
    if (!current[key]) {
      ops.push({ op: "delete", key });
    }
  });

  return ops;
}

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

export function applyDelta(base: Simulation, delta: SimulationDelta): Simulation {
  const result: Simulation = {
    ...base,
    currentTime: delta.t,
    events: [...base.events],
    state: { ...base.state },
    stores: { ...base.stores },
    dump: { ...base.dump },
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
        case "remove":
          result.events = result.events.filter((e) => e.id !== op.id);
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
        case "delete":
          delete result.state[op.key];
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

export function reconstructFromDeltas(base: Simulation, deltas: SimulationDelta[]): Simulation[] {
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
