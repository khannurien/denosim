import { Event, Process, Simulation } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
  timeout,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  const foo: Process = function* (
    sim: Simulation,
    _event: Event,
  ): Generator<Event | void, void, void> {
    while (sim.currentTime < 1000000) {
      console.log(`[${sim.currentTime}] foo`);
      yield* timeout(sim, 1);
    }
  };

  const e1 = createEvent(sim, 0, foo);
  sim.events = scheduleEvent(sim, e1);

  // error: Uncaught (in promise) RangeError: Maximum call stack size exceeded
  const stats = runSimulation(sim);

  console.log(`Simulation ended at ${sim.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
