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
 * TODO:
 */
export function serializeSimulation(states: Simulation[]): string {
  return JSON.stringify(states, replacer, 2);
}

/**
 * TODO:
 */
export function deserializeSimulation(data: string): Simulation[] {
  return JSON.parse(data, reviver);
}
