import { assert, assertEquals, assertThrows } from "@std/assert";
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

  const _stats = runSimulation(sim);
  assertEquals(sim.events.length, 1);
  assertEquals(sim.events[0].finishedAt, 10);

  assert(sim.events.every((event) => event.status == EventState.Finished));
});

Deno.test("basic out of order scheduling", () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, 10);
  const e2 = createEvent(sim, 5);
  const e3 = createEvent(sim, 15);
  assertEquals(sim.events.length, 0);

  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 3);

  const _stats = runSimulation(sim);
  assertEquals(sim.events.length, 3);

  assert(sim.events.every((event) => event.status == EventState.Finished));
});

Deno.test("basic event ordering", () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, 10);
  const e2 = createEvent(sim, 0);
  const e3 = createEvent(sim, 15);
  const e4 = createEvent(sim, 5);
  const e5 = createEvent(sim, 2);
  const e6 = createEvent(sim, 50);

  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e4);
  sim.events = scheduleEvent(sim, e5);
  sim.events = scheduleEvent(sim, e6);

  const _stats = runSimulation(sim);
  assertEquals(sim.events.length, 6);
  assert(sim.events.every((event) => event.status == EventState.Finished));
});

Deno.test("scheduling events in the past", () => {
  const sim = initializeSimulation();

  const cb = function* (sim: Simulation, _event: Event) {
    const past = createEvent(sim, sim.currentTime - 1);
    sim.events = scheduleEvent(sim, past);
    yield;
  };

  const e1 = createEvent(sim, -1);
  const e2 = createEvent(sim, 10, cb);

  assertThrows(() => {
    sim.events = scheduleEvent(sim, e1);
  });
  sim.events = scheduleEvent(sim, e2);

  assertThrows(() => {
    const _stats = runSimulation(sim);
  });
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

  const _stats = runSimulation(sim);
  assertEquals(results[10].id, e1.id);
  assertEquals(results[20].id, e2.id);
  assertEquals(results[30].id, e3.id);

  assert(sim.events.every((event) => event.status == EventState.Finished));
});

Deno.test("event timeout scheduling", () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, 10, function* (sim: Simulation, _event: Event) {
    yield* timeout(sim, 15);
  });

  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 1);

  const _stats = runSimulation(sim);
  assertEquals(sim.events.length, 2);

  assert(sim.events.every((event) => event.status == EventState.Finished));
});
