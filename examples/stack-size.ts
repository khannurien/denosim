import { Event, Process, ProcessState, Simulation } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
  timeout,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  let FOO = 0;

  const foo: Process = function* (
    sim: Simulation,
    event: Event,
  ): ProcessState {
    while (sim.currentTime < 10000000) {
      console.log(`[${sim.currentTime}] ${event.id} -- foo @ sleep: ${FOO}`);
      yield* timeout(sim, 1);
      FOO += 1;
      console.log(`[${sim.currentTime}] ${event.id} -- foo @ wake up: ${FOO}`);
    }
  };

  const e1 = createEvent(sim, 0, foo);
  sim.events = scheduleEvent(sim, e1);

  const stats = runSimulation(sim);

  console.log(`Simulation ended at ${sim.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
}
