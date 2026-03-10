import type { DeltaEncodedSimulation } from "./memory.ts";
import { reconstructFromDeltas } from "./memory.ts";
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
  return JSON.stringify(deltaEncoded, null, 2);
}

/**
 * Read simulation states from a JSON string.
 * This is the reverse operation of `serializeSimulation`.
 * It will restore the simulation state, including all functions.
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
