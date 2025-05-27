import { Process } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  const foo: Process<Record<string, string | undefined>> = function* (
    sim,
    event,
  ) {
    if (event.item) {
      console.log(`[${sim.currentTime}] got: ${event.item["got"]}`);
    }

    return yield;
  };

  const bar: Process<Record<string, string | undefined>> = function* (
    sim,
    event,
  ) {
    if (event.item) {
      event.item["got"] = "bar";
      console.log(`[${sim.currentTime}] wrote "bar"`);
    }

    return yield;
  };

  const barStore: Record<string, string | undefined> = {
    "got": undefined,
  };

  const e1 = createEvent(sim, 20, bar, barStore);
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 25, foo, barStore);
  sim.events = scheduleEvent(sim, e2);

  const [stop, stats] = runSimulation(sim);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
