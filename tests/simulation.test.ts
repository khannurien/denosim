import { assert, assertEquals } from "@std/assert";
import { Event, EventState, Simulation } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
  timeout,
} from "../src/simulation.ts";

Deno.test("basic event scheduling", () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, 10);
  assertEquals(sim.events.length, 0);

  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 1);

  runSimulation(sim);
  assertEquals(sim.events.length, 1);
  assertEquals(sim.events[0].status, EventState.Finished);
  assertEquals(sim.events[0].finishedAt, 10);
});

Deno.test("event callbacks scheduling", () => {
  const sim = initializeSimulation();

  const results: Record<number, Event> = {};

  const cb = function* (sim: Simulation, event: Event) {
    results[sim.currentTime] = event;
    yield;
  };

  const e1 = createEvent(sim, 10, cb);
  const e2 = createEvent(sim, 20, cb);
  const e3 = createEvent(sim, 30, cb);
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  assertEquals(sim.events.length, 3);

  runSimulation(sim);
  assertEquals(results[10].id, e1.id);
  assertEquals(results[20].id, e2.id);
  assertEquals(results[30].id, e3.id);
});

Deno.test("event timeout scheduling", () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, 10, function* (sim: Simulation, _event: Event) {
    yield* timeout(sim, 15);
  });

  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 1);

  runSimulation(sim);
  assertEquals(sim.events.length, 2);
  assert(sim.events.every((event) => event.status == EventState.Finished));
});
