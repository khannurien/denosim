import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createEvent,
  Event,
  EventState,
  initializeSimulation,
  ProcessDefinition,
  ProcessHandler,
  registerProcess,
  runSimulation,
  scheduleEvent,
  StateData,
} from "../mod.ts";

Deno.test("basic serialization", () => {
  const sim = initializeSimulation();
});
