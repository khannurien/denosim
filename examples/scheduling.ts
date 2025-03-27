import { Event, Process, Simulation } from "../src/model.ts";
import {
  create_event,
  initialize_simulation,
  run_simulation,
  schedule_event,
  timeout,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initialize_simulation();

  const foo: Process = function* (
    sim: Simulation,
    _event: Event,
  ): Generator<Event | void, void, void> {
    console.log(`[${sim.current_time}] foo`);
    yield;
  };

  const bar: Process = function* (
    sim: Simulation,
    _event: Event,
  ): Generator<Event | void, void, void> {
    const cb = function* (
      sim: Simulation,
      _event: Event,
    ): Generator<Event | void, void, void> {
      console.log(`[${sim.current_time}] callback from bar before timeout`);
      yield* timeout(sim, 5);
      console.log(`[${sim.current_time}] callback from bar after timeout`);
    };

    console.log(`[${sim.current_time}] bar before timeout`);
    yield* timeout(sim, 15, cb);
    console.log(`[${sim.current_time}] bar after timeout`);
  };

  const e1 = create_event(sim, 10, foo);
  sim.events = schedule_event(sim, e1);

  const e2 = create_event(sim, 20, bar);
  sim.events = schedule_event(sim, e2);

  const e3 = create_event(sim, 30, foo);
  sim.events = schedule_event(sim, e3);

  const e4 = create_event(sim, 50, foo);
  sim.events = schedule_event(sim, e4);

  run_simulation(sim);

  console.log(`Simulation ended at ${sim.current_time}`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
