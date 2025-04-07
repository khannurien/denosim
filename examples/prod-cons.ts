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

  const prod: Process<string> = function* (
    sim: Simulation,
    event: Event<string>,
  ) {
    const item = "foobar";
    yield* put(sim, event, store, item);
    console.log(`[${sim.currentTime}] Prod -- put ${item} in store`);
  };

  const cons: Process<string> = function* (
    sim: Simulation,
    event: Event<string>,
  ) {
    yield* get(sim, event, store);
    const item = event.item;
    console.log(
      `[${sim.currentTime}] Cons -- item: ${JSON.stringify(item, null, 2)}`,
    );
  };

  const e1 = createEvent(sim, 30, cons);
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, 25, prod);
  sim.events = scheduleEvent(sim, e2);

  const stats = runSimulation(sim);

  console.log(`Simulation ended at ${sim.currentTime}`);
  console.log(`Simulation took: ${stats.duration} ms`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
