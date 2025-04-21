import { Process, Store } from "../src/model.ts";
import { createStore, get, put } from "../src/resources.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

/**
 * Expected output (non-blocking):
 *
 * [20] Cons -- trying to get [#1]...
 * [25] Prod -- put foobar in store
 * [25] Cons -- item: "foobar"
 * [25] Prod -- done [#1]...
 * [45] Prod -- put foobar in store
 * [45] Prod -- done [#2]...
 * [50] Cons -- trying to get [#2]...
 * [50] Cons -- item: "foobar"
 * [60] Cons -- trying to get [#3]...
 * [60] Prod -- put foobar in store
 * [60] Cons -- item: "foobar"
 * [60] Prod -- done [#3]...
 *
 * Expected output (blocking):
 * [20] Cons -- trying to get [#1]...
 * [25] Prod -- put foobar in store
 * [25] Cons -- item: "foobar"
 * [25] Prod -- done [#1]...
 * [45] Prod -- put foobar in store
 * [50] Cons -- trying to get [#2]...
 * [50] Prod -- done [#2]...
 * [50] Cons -- item: "foobar"
 * [60] Cons -- trying to get [#3]...
 * [60] Prod -- put foobar in store
 * [60] Cons -- item: "foobar"
 * [60] Prod -- done [#3]...
 */
if (import.meta.main) {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>(1);

  let consCount = 0;
  let prodCount = 0;

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    console.log(`[${sim.currentTime}] Prod -- put ${item} in store`);
    const step = yield* put(sim, event, store, item);
    console.log(`[${step.sim.currentTime}] Prod -- done [#${++prodCount}]...`);

    return step;
  };

  const cons: Process<string> = function* (sim, event) {
    console.log(
      `[${sim.currentTime}] Cons -- trying to get [#${++consCount}]...`,
    );
    const step = yield* get(sim, event, store);
    console.log(
      `[${step.sim.currentTime}] Cons -- item: ${
        JSON.stringify(step.event.item, null, 2)
      }`,
    );

    return step;
  };

  const e1 = createEvent(sim, 20, cons);
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 25, prod);
  sim.events = scheduleEvent(sim, e2);

  const e3 = createEvent(sim, 45, prod);
  sim.events = scheduleEvent(sim, e3);

  const e4 = createEvent(sim, 50, cons);
  sim.events = scheduleEvent(sim, e4);

  const e5 = createEvent(sim, 60, prod);
  sim.events = scheduleEvent(sim, e5);

  const e6 = createEvent(sim, 60, cons);
  sim.events = scheduleEvent(sim, e6);

  const [stop, stats] = runSimulation(sim);

  console.log(`Simulation ended at ${stop.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(stop.events, null, 2));
}
