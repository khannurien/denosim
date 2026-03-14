import type { DeltaEncodedSimulation } from "./memory.ts";
import { applyDeltas, reconstructFromDeltas } from "./memory.ts";
import type {
  DisciplineRegistry,
  PredicateRegistry,
  ProcessRegistry,
  Simulation,
} from "./model.ts";

/**
 * The whole simulation should be completely serializable to JSON.
 * That allows to store the simulation state and resume it at any point.
 * This is useful for long-running simulations (e.g. for replaying or branch exploration).
 */
export function serializeSimulation(
  deltaEncoded: DeltaEncodedSimulation,
): string {
  return JSON.stringify(deltaEncoded);
}

/**
 * Serializes only the base and deltas for on-disk dump files.
 * `current` is always reconstructable from `base + deltas` and is omitted to reduce file size.
 */
export function serializeForDump(encoded: DeltaEncodedSimulation): string {
  return JSON.stringify({ base: encoded.base, deltas: encoded.deltas });
}

/**
 * Restores simulation states from a JSON string produced by `serializeSimulation`.
 * Registries that are initialized in user code must be passed to the function.
 * The simulation can then be resumed from the point where it was serialized.
 */
export function deserializeSimulation(
  data: string,
  processes: ProcessRegistry,
  disciplines: DisciplineRegistry,
  predicates: PredicateRegistry,
): Simulation[] {
  const deltaEncoded: DeltaEncodedSimulation = JSON.parse(data);
  const states = reconstructFromDeltas(deltaEncoded.base, deltaEncoded.deltas);

  for (const sim of states) {
    sim.processes = processes;
    sim.predicates = predicates;
    sim.disciplines = disciplines;
  }

  return states;
}

/**
 * Like `deserializeSimulation` but returns only the final reconstructed state.
 * Use when intermediate states are not needed (e.g. checkpoint resume in reconstructFullCurrent).
 */
export function deserializeLastSimulation(
  data: string,
  processes: ProcessRegistry,
  disciplines: DisciplineRegistry,
  predicates: PredicateRegistry,
): Simulation {
  const deltaEncoded: DeltaEncodedSimulation = JSON.parse(data);
  const sim = applyDeltas(deltaEncoded.base, deltaEncoded.deltas);
  sim.processes = processes;
  sim.predicates = predicates;
  sim.disciplines = disciplines;
  return sim;
}
