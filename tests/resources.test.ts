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
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;

    return step;
  };

  const e1 = createEvent(sim, 0, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 0, cons);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 10, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 20, cons);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

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
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;

    return step;
  };

  const e1 = createEvent(sim, 30, cons);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 40, prod);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 50, cons);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 50, prod);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

  assertEquals(result[e1.id], "foobar");
  assertEquals(result[e3.id], "foobar");

  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("blocking/non-blocking put operations", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();
  const result: Record<string, string | undefined> = {};
  const timings: Record<string, number> = {};

  const prodBlock: Process<string> = function* (sim, event) {
    const item = "foobar";
    const step = yield* put(sim, event, store, item, true);
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    const step = yield* put(sim, event, store, item);
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const cons: Process<string> = function* (sim, event) {
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const e1 = createEvent(sim, 30, prodBlock);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 40, cons);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 50, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 60, cons);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

  assertEquals(result[e2.id], "foobar");

  assertEquals(timings[e1.id], 40);
  assertEquals(timings[e2.id], 40);
  assertEquals(timings[e3.id], 50);
  assertEquals(timings[e4.id], 60);

  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("store capacity = 0", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>(0);
  const result: Record<string, string | undefined> = {};
  const timings: Record<string, number> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    const step = yield* put(sim, event, store, item);
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const cons: Process<string> = function* (sim, event) {
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const e1 = createEvent(sim, 0, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 10, prod);
  sim.events = scheduleEvent(sim, e2);
  const e3 = createEvent(sim, 20, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 30, cons);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

  assertEquals(result[e4.id], "foobar");
  assertEquals(timings[e1.id], 30);

  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("store capacity > 0", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>(1);
  const result: Record<string, string | undefined> = {};
  const timings: Record<string, number> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    const step = yield* put(sim, event, store, item);
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const cons: Process<string> = function* (sim, event) {
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;
    timings[event.id] = step.sim.currentTime;

    return step;
  };

  const e1 = createEvent(sim, 0, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 10, prod);
  sim.events = scheduleEvent(sim, e2);
  const e3 = createEvent(sim, 20, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 30, cons);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

  assertEquals(result[e4.id], "foobar");
  assertEquals(timings[e4.id], 30);

  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 1);
  assertEquals(store.delayedPutRequests.length, 1);
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
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;

    return step;
  };

  const e1 = createEvent(sim, 50, cons);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 55, cons);
  sim.events = scheduleEvent(sim, e2);
  const e3 = createEvent(sim, 60, cons);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 70, prod);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

  assertEquals(result[e1.id], "foobar");
  assertEquals(result[e2.id], undefined);
  assertEquals(result[e3.id], undefined);

  assertEquals(store.getRequests.length, 2);
  assertEquals(store.putRequests.length, 0);
});

Deno.test("prod > cons: unbalanced store operations", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>(3);
  const result: Record<string, string | undefined> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    return yield* put(sim, event, store, item);
  };

  const cons: Process<string> = function* (sim, event) {
    const step = yield* get(sim, event, store);
    result[event.id] = step.event.item;

    return step;
  };

  const e1 = createEvent(sim, 50, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 55, prod);
  sim.events = scheduleEvent(sim, e2);
  const e3 = createEvent(sim, 60, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 70, cons);
  sim.events = scheduleEvent(sim, e4);

  const [_stop, _stats] = runSimulation(sim);

  assertEquals(result[e4.id], "foobar");

  assertEquals(store.getRequests.length, 0);
  assertEquals(store.putRequests.length, 2);
});
