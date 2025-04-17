import { assertEquals } from "@std/assert";
import { Process, Store } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";
import { createStore, get, put } from "../src/resources.ts";

Deno.test("basic store operations", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();
  const result: Record<string, string | undefined> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    return yield* put(sim, event, store, item);
  };

  const cons: Process<string> = function* (sim, event) {
    const [newSim, newEvent] = yield* get(sim, event, store);
    result[event.id] = newEvent.item;

    return [newSim, newEvent];
  };

  const e1 = createEvent(sim, 0, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 0, cons);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 10, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 20, cons);
  sim.events = scheduleEvent(sim, e4);

  const _stats = runSimulation(sim);

  assertEquals(result[e2.id], "foobar");
  assertEquals(result[e4.id], "foobar");
  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("out-of-order store operations", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();
  const result: Record<string, string | undefined> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    return yield* put(sim, event, store, item);
  };

  const cons: Process<string> = function* (sim, event) {
    const [newSim, newEvent] = yield* get(sim, event, store);
    result[event.id] = newEvent.item;

    return [newSim, newEvent];
  };

  const e1 = createEvent(sim, 30, cons);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 40, prod);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 50, cons);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 50, prod);
  sim.events = scheduleEvent(sim, e4);

  const _stats = runSimulation(sim);

  assertEquals(result[e1.id], "foobar");
  assertEquals(result[e3.id], "foobar");
  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("cons > prod: unbalanced store operations", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();
  const result: Record<string, string | undefined> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    return yield* put(sim, event, store, item);
  };

  const cons: Process<string> = function* (sim, event) {
    const [newSim, newEvent] = yield* get(sim, event, store);
    result[event.id] = newEvent.item;

    return [newSim, newEvent];
  };

  const e1 = createEvent(sim, 50, cons);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 55, cons);
  sim.events = scheduleEvent(sim, e2);
  const e3 = createEvent(sim, 60, cons);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 70, prod);
  sim.events = scheduleEvent(sim, e4);

  const _stats = runSimulation(sim);

  assertEquals(result[e1.id], "foobar");
  assertEquals(result[e2.id], undefined);
  assertEquals(result[e3.id], undefined);
  assertEquals(store.getRequests.length, 2);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("prod > cons: unbalanced store operations", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();
  const result: Record<string, string | undefined> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    return yield* put(sim, event, store, item);
  };

  const cons: Process<string> = function* (sim, event) {
    const [newSim, newEvent] = yield* get(sim, event, store);
    result[event.id] = newEvent.item;

    return [newSim, newEvent];
  };

  const e1 = createEvent(sim, 50, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 55, prod);
  sim.events = scheduleEvent(sim, e2);
  const e3 = createEvent(sim, 60, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 70, cons);
  sim.events = scheduleEvent(sim, e4);

  const _stats = runSimulation(sim);

  assertEquals(result[e4.id], "foobar");
  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 2);
});
