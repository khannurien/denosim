import type { HistoryWindow } from "./memory.ts";
import type { Simulation, SimulationRegistries } from "./model.ts";

/**
 * The whole simulation should be completely serializable to JSON.
 * That allows to store the simulation state and resume it at any point.
 * This is useful for long-running simulations (e.g. for replaying or branch exploration).
 * Registries hold functions and are left out; they are passed back in to `deserializeSimulation`.
 */
export function serializeSimulation(sim: Simulation): string {
  const {
    processes: _processes,
    disciplines: _disciplines,
    predicates: _predicates,
    ...data
  } = sim;

  return JSON.stringify(data);
}

/**
 * Restores a simulation from a JSON string produced by `serializeSimulation`.
 * Registries that are initialized in user code must be passed to the function.
 * The simulation can then be resumed from the point where it was serialized.
 */
export function deserializeSimulation(
  data: string,
  registries: SimulationRegistries,
): Simulation {
  const sim: Simulation = JSON.parse(data);

  return {
    ...sim,
    processes: registries.processes,
    disciplines: registries.disciplines,
    predicates: registries.predicates,
  };
}

/**
 * Serializes a history window for an on-disk dump file.
 */
export function serializeForDump(window: HistoryWindow): string {
  return JSON.stringify({ base: window.base, deltas: window.deltas });
}

/**
 * Restores a history window from a JSON string produced by `serializeForDump`.
 * Registries that are initialized in user code must be passed to the function.
 */
export function deserializeDump(
  data: string,
  registries: SimulationRegistries,
): HistoryWindow {
  const window: HistoryWindow = JSON.parse(data);

  return {
    base: {
      ...window.base,
      processes: registries.processes,
      disciplines: registries.disciplines,
      predicates: registries.predicates,
    },
    deltas: window.deltas,
  };
}
