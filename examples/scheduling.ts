import { Event, Process, Simulation } from "../src/model.ts";
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
  ) {
    console.log(`[${sim.currentTime}] foo`);
    return yield;
  };

  const bar: Process = function* (sim, _event) {
    const step1: Process = function* (sim, _event) {
      console.log(`[${sim.currentTime}] callback from bar before timeout`);
      return yield* timeout(sim, 5, step2);
    };
    const step2: Process = function* (sim, _event) {
      console.log(`[${sim.currentTime}] callback from bar after timeout`);
      return yield;
    };
    console.log(`[${sim.currentTime}] bar before timeout`);
    const [newSim, newEvent] = yield* timeout(sim, 15, step1);
    console.log(`[${newSim.currentTime}] bar after timeout`);

    return [newSim, newEvent];
  };

  const baz: Process = function* (sim, _event) {
    console.log(`[${sim.currentTime}] baz before`);

    const future = createEvent(sim, sim.currentTime + 10, foo);
    const [newSim, newEvent] = yield future;

    console.log(`[${newSim.currentTime}] baz after`);

    return [newSim, newEvent];
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

  const e6 = createEvent(sim, 60, baz);
  sim.events = scheduleEvent(sim, e6);

  const [stop, stats] = runSimulation(sim);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
