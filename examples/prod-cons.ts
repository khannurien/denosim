import { Process, Store } from "../src/model.ts";
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

  const prod: Process<string> = function* (sim, event) {
    const item = "foobar";
    console.log(`[${sim.currentTime}] Prod -- put ${item} in store`);
    const [newSim, newEvent] = yield* put(sim, event, store, item);
    console.log(`[${sim.currentTime}] Prod -- done [#${++prodCount}]...`);

    return [newSim, newEvent];
  };

  const cons: Process<string> = function* (sim, event) {
    console.log(
      `[${sim.currentTime}] Cons -- trying to get [#${++consCount}]...`,
    );
    const [newSim, newEvent] = yield* get(sim, event, store);
    console.log(
      `[${sim.currentTime}] Cons -- item: ${
        JSON.stringify(newEvent.item, null, 2)
      }`,
    );

    return [newSim, newEvent];
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
