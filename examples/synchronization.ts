// import { timeout } from "../mod.ts";
// import { Process, Store } from "../src/model.ts";
// import { createStore, get, put } from "../src/resources.ts";
// import {
//   createEvent,
//   initializeSimulation,
//   runSimulation,
//   scheduleEvent,
// } from "../src/simulation.ts";

// if (import.meta.main) {
//   const sim = initializeSimulation();

//   const store: Store<boolean> = createStore<boolean>();

//   const p1: Process<boolean> = function* (sim, _event) {
//     let step = yield* timeout(sim, 10);
//     console.log(`[${step.sim.currentTime}] p1 -- true`);
//     step = yield* put(step.sim, step.event, store, true);
//     console.log(`[${step.sim.currentTime}] p1 -- done`);

//     console.log(`[${step.sim.currentTime}] p1 -- trying...`);
//     step = yield* get(step.sim, step.event, store);
//     console.log(`[${step.sim.currentTime}] p1 -- ${step.event}: success!`);

//     return yield;
//   };

//   const p2: Process<boolean> = function* (sim, event) {
//     console.log(`[${sim.currentTime}] p2 -- trying...`);
//     let step = yield* get(sim, event, store);
//     console.log(`[${step.sim.currentTime}] p2 -- ${step.event}: success!`);
//     step = yield* timeout(step.sim, 20);
//     step = yield* put(step.sim, step.event, store, true);
//     console.log(`[${step.sim.currentTime}] p2 -- done`);

//     return yield;
//   };

//   const e1 = createEvent(sim, 0, p1);
//   sim.events = scheduleEvent(sim, e1);

//   const e2 = createEvent(sim, 0, p2);
//   sim.events = scheduleEvent(sim, e2);

//   const [stop, stats] = runSimulation(sim);

//   console.log(`Simulation ended at ${stop.currentTime}`);
//   console.log(`Simulation took: ${stats.duration} ms`);
//   console.log("Events:", JSON.stringify(stop.events, null, 2));
// }
