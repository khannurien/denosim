import { Event, Process, Simulation, Store } from "../src/model.ts";
import { createStore, get, put } from "../src/resources.ts";
import {
  createEvent,
  initializeSimulation,
  runSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

if (import.meta.main) {
  const sim = initializeSimulation();

  const store: Store<string> = createStore<string>();

  let consCount = 0;
  let prodCount = 0;

  const prod: Process<string> = function* (
    sim: Simulation,
    event: Event<string>,
  ) {
    const item = "foobar";
    console.log(`[${sim.currentTime}] Prod -- put ${item} in store`);
    yield* put(sim, event, store, item);
    console.log(`[${sim.currentTime}] Prod -- done [#${++prodCount}]...`);
  };

  const cons: Process<string> = function* (
    sim: Simulation,
    event: Event<string>,
  ) {
    console.log(
      `[${sim.currentTime}] Cons -- trying to get [#${++consCount}]...`,
    );
    const item = yield* get(sim, event, store);
    console.log(
      `[${sim.currentTime}] Cons -- item: ${JSON.stringify(item, null, 2)}`,
    );
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

  const stats = runSimulation(sim);

  console.log(`Simulation ended at ${sim.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
