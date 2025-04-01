import { Event, Process, ProcessStep, Simulation } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
  timeout,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  const foo: Process<Record<string, string | undefined>> = function* (
    sim: Simulation,
    event: Event<Record<string, string | undefined>>,
  ): ProcessStep<Record<string, string | undefined>> {
    if (event.item) {
      console.log(`[${sim.currentTime}] got: ${event.item["got"]}`);
    }

    yield;
  };

  const bar: Process<Record<string, string | undefined>> = function* (
    sim: Simulation,
    event: Event<Record<string, string | undefined>>,
  ): ProcessStep<Record<string, string | undefined>> {
    if (event.item) {
      event.item["got"] = "bar";
      console.log(`[${sim.currentTime}] wrote "bar"`);
    }
    yield;
  };

  const barStore: Record<string, string | undefined> = {
    "got": undefined,
  };

  const e1 = createEvent(sim, 20, bar, barStore);
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 25, foo, barStore);
  sim.events = scheduleEvent(sim, e2);

  const stats = runSimulation(sim);

  console.log(`Simulation ended at ${sim.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
