import { Event, Process, ProcessStep, Simulation } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
  timeout,
} from "../src/simulation.ts";

/**
 * Expected output:
 *
 * [10] foo
 * [20] bar before timeout
 * [30] foo
 * [35] callback from bar before timeout
 * [35] bar after timeout
 * [37] foo
 * [40] callback from bar after timeout
 * [50] foo
 * Simulation ended at 50
 */
if (import.meta.main) {
  const sim = initializeSimulation();

  const foo: Process = function* (
    sim: Simulation,
    _event: Event,
  ): ProcessStep {
    console.log(`[${sim.currentTime}] foo`);
    yield;
  };

  const bar: Process = function* (
    sim: Simulation,
    _event: Event,
  ): ProcessStep {
    const cb: Process = function* (
      sim: Simulation,
      _event: Event,
    ): ProcessStep {
      console.log(`[${sim.currentTime}] callback from bar before timeout`);
      yield* timeout(sim, 5);
      console.log(`[${sim.currentTime}] callback from bar after timeout`);
    };

    console.log(`[${sim.currentTime}] bar before timeout`);
    yield* timeout(sim, 15, cb);
    console.log(`[${sim.currentTime}] bar after timeout`);
  };

  const e1 = createEvent(sim, 10, foo);
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 20, bar);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 30, foo);
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent(sim, 37, foo);
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent(sim, 50, foo);
  sim.events = scheduleEvent(sim, e5);

  const stats = runSimulation(sim);

  console.log(`Simulation ended at ${sim.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
