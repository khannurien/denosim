import { Simulation } from "./model.ts";

/**
 * Inspired by true events:
 * https://oprearocks.medium.com/serializing-object-methods-using-es6-template-strings-and-eval-c77c894651f0
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") {
    const functionString = value.toString();
    // Handle shorthand syntax
    return functionString.indexOf("function ") === 0
      ? functionString
      : `function ${functionString}`;
  }

  return value;
}

function reviver(_key: string, value: unknown): unknown {
  return typeof value === "string" && value.indexOf("function ") === 0
    ? eval(`(${value})`)
    : value;
}

/**
 * The whole simulation should be completely serializable to JSON.
 * That allows to store the simulation state and resume it at any point.
 * This is useful for long-running simulations (e.g. for replaying or branch exploration).
 * TODO: Explore how to store deltas instead of the whole state
 */
export function serializeSimulation(states: Simulation[]): string {
  return JSON.stringify(states, replacer, 2);
}

/**
 * Read simulation states from a JSON string.
 * This is the reverse operation of `serializeSimulation`.
 * It will restore the simulation state, including all functions.
 * The simulation can then be resumed from the point where it was serialized.
 * TODO: Explore how to resume from deltas instead of the whole state
 */
export function deserializeSimulation(data: string): Simulation[] {
  return JSON.parse(data, reviver);
}
