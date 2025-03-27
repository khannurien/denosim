import { assert, assertEquals } from "@std/assert";
import { Event, EventState, Simulation } from "../src/model.ts";
import {
  create_event,
  initialize_simulation,
  run_simulation,
  schedule_event,
  timeout,
} from "../src/simulation.ts";

Deno.test("basic event scheduling", () => {
  const sim = initialize_simulation();

  const e1 = create_event(sim, 10);
  assertEquals(sim.events.length, 0);

  sim.events = schedule_event(sim, e1);
  assertEquals(sim.events.length, 1);

  run_simulation(sim);
  assertEquals(sim.events.length, 1);
  assertEquals(sim.events[0].status, EventState.Finished);
  assertEquals(sim.events[0].finished_at, 10);
});

Deno.test("event callbacks scheduling", () => {
  const sim = initialize_simulation();

  const results: Record<number, Event> = {};

  const cb = function* (sim: Simulation, event: Event) {
    results[sim.current_time] = event;
    yield;
  };

  const e1 = create_event(sim, 10, cb);
  const e2 = create_event(sim, 20, cb);
  const e3 = create_event(sim, 30, cb);
  sim.events = schedule_event(sim, e1);
  sim.events = schedule_event(sim, e2);
  sim.events = schedule_event(sim, e3);
  assertEquals(sim.events.length, 3);

  run_simulation(sim);
  assertEquals(results[10].id, e1.id);
  assertEquals(results[20].id, e2.id);
  assertEquals(results[30].id, e3.id);
});

Deno.test("event timeout scheduling", () => {
  const sim = initialize_simulation();

  const e1 = create_event(sim, 10, function* (sim: Simulation, _event: Event) {
    yield* timeout(sim, 15);
  });

  sim.events = schedule_event(sim, e1);
  assertEquals(sim.events.length, 1);

  run_simulation(sim);
  assertEquals(sim.events.length, 2);
  assert(sim.events.every((event) => event.status == EventState.Finished));
});
