import { assertEquals } from "@std/assert";
import { Process, Store } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";
import { createStore, get, put } from "../src/resources.ts";

Deno.test("ordered inter-process synchronization", () => {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();
  const result: Record<string, string> = {};

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    yield* put(sim, event, store, item);
  };

  const cons: Process<string> = function* (sim, event) {
    const item = yield* get(sim, event, store);

    if (item) {
      result[event.id] = item;
    }
  };

  const e1 = createEvent(sim, 0, prod);
  sim.events = scheduleEvent(sim, e1);
  const e2 = createEvent(sim, 0, cons);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 10, prod);
  sim.events = scheduleEvent(sim, e3);
  const e4 = createEvent(sim, 20, cons);
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent(sim, 30, cons);
  sim.events = scheduleEvent(sim, e5);
  const e6 = createEvent(sim, 40, prod);
  sim.events = scheduleEvent(sim, e6);

  const e7 = createEvent(sim, 45, cons);
  sim.events = scheduleEvent(sim, e7);
  const e8 = createEvent(sim, 45, prod);
  sim.events = scheduleEvent(sim, e8);

  const e9 = createEvent(sim, 50, cons);
  sim.events = scheduleEvent(sim, e9);
  const e10 = createEvent(sim, 55, cons);
  sim.events = scheduleEvent(sim, e10);
  const e11 = createEvent(sim, 60, cons);
  sim.events = scheduleEvent(sim, e11);
  const e12 = createEvent(sim, 70, prod);
  sim.events = scheduleEvent(sim, e12);

  const _stats = runSimulation(sim);

  assertEquals(result[e2.id], "foobar");
  assertEquals(result[e4.id], "foobar");
  assertEquals(result[e5.id], "foobar");
  assertEquals(result[e7.id], "foobar");
  assertEquals(result[e9.id], "foobar");
  assertEquals(result[e10.id], undefined);
  assertEquals(result[e11.id], undefined);
  assertEquals(store.requests.length, 2);
});
