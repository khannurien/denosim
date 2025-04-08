import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  Event,
  EventState,
  Process,
  ProcessStep,
  Simulation,
} from "../src/model.ts";
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

Deno.test("zero-duration events", () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, sim.currentTime);
  sim.events = scheduleEvent(sim, e1);

  const _stats = runSimulation(sim);
  assertEquals(sim.events[0].finishedAt, 0);
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

  const processedOrder: number[] = [];
  const cb: Process = function* (_sim: Simulation, event: Event) {
    processedOrder.push(event.scheduledAt);
    yield;
  };

  const e1 = createEvent(sim, 10, cb);
  const e2 = createEvent(sim, 0, cb);
  const e3 = createEvent(sim, 15, cb);
  const e4 = createEvent(sim, 5, cb);
  const e5 = createEvent(sim, 2, cb);
  const e6 = createEvent(sim, 50, cb);

  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e4);
  sim.events = scheduleEvent(sim, e5);
  sim.events = scheduleEvent(sim, e6);

  const _stats = runSimulation(sim);
  assertEquals(sim.events.length, 6);
  assertEquals(processedOrder, [0, 2, 5, 10, 15, 50]);
  assert(sim.events.every((event) => event.status == EventState.Finished));
});

Deno.test("scheduling events in the past", () => {
  const sim = initializeSimulation();

  const cb: Process = function* (sim: Simulation, _event: Event) {
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

  const cb: Process = function* (sim: Simulation, event: Event) {
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

Deno.test("event item passing", () => {
  const sim = initializeSimulation();

  const foo: Process<Record<string, string | undefined>> = function* (
    _sim: Simulation,
    event: Event<Record<string, string | undefined>>,
  ): ProcessStep<Record<string, string | undefined>> {
    if (event.item) {
      event.item["foo"] = "foo";
    }

    yield;
  };

  const bar: Process<Record<string, string | undefined>> = function* (
    _sim: Simulation,
    event: Event<Record<string, string | undefined>>,
  ): ProcessStep<Record<string, string | undefined>> {
    if (event.item) {
      event.item["bar"] = "bar";
    }
    yield;
  };

  const barStore: Record<string, string | undefined> = {
    "foo": undefined,
    "bar": undefined,
  };

  const e1 = createEvent(sim, 20, foo, barStore);
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 25, bar, barStore);
  sim.events = scheduleEvent(sim, e2);

  const _stats = runSimulation(sim);

  assertEquals(barStore["foo"], "foo");
  assertEquals(barStore["bar"], "bar");
});

Deno.test("event timeout scheduling", () => {
  const sim = initializeSimulation();

  const timings: Record<string, number> = {
    "before": -1,
    "after": -1,
  };

  const cb: Process<Record<string, number>> = function* (
    sim: Simulation,
    event: Event<Record<string, number>>,
  ) {
    if (!event.item) {
      throw Error("Event item not set.");
    }

    event.item["before"] = sim.currentTime;
    yield* timeout(sim, 15);
    event.item["after"] = sim.currentTime;
  };

  const e1 = createEvent(sim, 10, cb, timings);

  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 1);

  const _stats = runSimulation(sim);
  assertEquals(sim.events.length, 2);

  // Test timeout event scheduling
  const timeoutEvents = sim.events.filter((e) => e.id !== e1.id);
  assertEquals(timeoutEvents.length, 1);
  assertEquals(timeoutEvents[0].scheduledAt, 25);
  // Test resumed execution of caller after timeout
  assertEquals(timings["before"], 10);
  assertEquals(timings["after"], 25);

  assert(sim.events.every((event) => event.status == EventState.Finished));
});
