import type { ProcessDefinition, Simulation, StateData } from "../mod.ts";
import {
  continueEvent,
  createEvent,
  get,
  initializeSimulation,
  initializeStore,
  put,
  registerProcess,
  runSimulation,
  scheduleEvent,
} from "../mod.ts";

/**
 * A small cluster: jobs queue for a node, run on it, then release it.
 * At t=10 jobs are piling up and an operator has to decide: keep the two nodes, or rent a third one.
 * The run is paused right before the decision, then resumed once per side, from the same state.
 * Nothing is kept outside the simulation: the workload is scheduled up front, and finished jobs end in a store.
 *
 * deno run examples/branch.ts
 *
 * Expected output:
 *
 * Paused at 10, before the decision: 1 job waiting
 * keep: 12 jobs done, mean wait 3.8, max wait 8, ended at 35
 * rent: 12 jobs done, mean wait 0.8, max wait 2, ended at 28
 */

interface Node extends StateData {
  node: string;
}

interface Job extends StateData {
  job: number;
  arrival: number;
  duration: number;
}

interface Running extends Job {
  node: string;
  start: number;
}

type Stores = { nodes: Node; done: Running };

const job: ProcessDefinition<
  {
    queue: Job;
    run: Job;
    release: Running;
  },
  Stores,
  { run: Node },
  "queue"
> = {
  type: "job",
  initial: "queue",
  steps: {
    // First step, run by the event that starts the job
    // Blocks until a node is free; the token arrives with the event that runs the next step
    queue(sim, event, state) {
      const { step, resume, finish } = get(sim, event, "nodes");

      return {
        state: { ...state, step: "run" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    // Run once a node is handed over: read from the event, and kept in the data with the start time
    // Timeout: the next step runs once the job is over
    run(sim, event, state) {
      return {
        state: {
          ...state,
          step: "release",
          data: {
            ...state.data,
            node: event.process.data.node,
            start: sim.currentTime,
          },
        },
        next: [continueEvent(event, sim.currentTime + state.data.duration)],
      };
    },
    // Run by the timeout: last step
    // Puts the node back, and leaves what the job went through in `done`
    release(sim, event, state) {
      // Two store operations in one step: only their `resume` and `finish` are passed on, the job ends here
      // Sound as neither store is ever full
      const released = [
        put(sim, event, "nodes", { node: state.data.node }),
        put(sim, event, "done", state.data),
      ];

      return {
        state,
        next: released.flatMap(({ resume }) => resume ?? []),
        finish: released.flatMap(({ finish }) => finish ?? []),
      };
    },
  },
};

/** One side of the decision: nothing changes */
const keep: ProcessDefinition<{ decide: StateData }, Stores> = {
  type: "operator",
  initial: "decide",
  steps: {
    // Only step, run by the operator's event: scheduled under a type, it runs the definition registered under that type when it is handled
    decide(_sim, _event, state) {
      return { state, next: [] };
    },
  },
};

/** The other side: one more token in the store */
const rent: ProcessDefinition<{ decide: StateData }, Stores> = {
  type: "operator",
  initial: "decide",
  steps: {
    // Same event, other definition
    decide(sim, event, state) {
      // `step` is not passed on, the operator ends here: sound as the store has room for a third node
      const { resume, finish } = put(sim, event, "nodes", { node: "n3" });

      return { state, next: resume ?? [], finish };
    },
  },
};

if (import.meta.main) {
  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: {
      nodes: initializeStore({ capacity: 3 }),
      done: initializeStore({ capacity: Number.MAX_SAFE_INTEGER }),
    },
  };
  for (const node of ["n1", "n2"]) {
    put(sim, createEvent({ scheduledAt: 0 }), "nodes", { node });
  }

  sim.processes = registerProcess(sim, job);

  const durations = [5, 6, 4, 7, 5, 6, 8, 4, 5, 6, 7, 5];
  for (const [i, duration] of durations.entries()) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({
        scheduledAt: 2 * i,
        process: { type: job, data: { job: i + 1, arrival: 2 * i, duration } },
      }),
    );
  }

  sim.timeline = scheduleEvent(
    sim,
    createEvent({ scheduledAt: 10, process: { type: "operator" } }),
  );

  // Pause right before the decision: the operator's event stays scheduled
  const { result: paused } = await runSimulation(sim, {
    until: (_sim, next) => next.process.type === "operator",
  });

  console.log(
    `Paused at ${paused.currentTime}, before the decision: ${
      paused.stores["nodes"].getRequests.entries.length
    } job waiting`,
  );

  // One run per side, each from a copy of the paused state holding its own operator; `paused` is left untouched
  for (const [side, operator] of Object.entries({ keep, rent })) {
    const branch = {
      ...paused,
      processes: registerProcess(paused, operator),
    };

    const { result } = await runSimulation(branch);

    const waits = result.stores.done.buffer.entries.map(({ event }) =>
      (event.process.data?.start ?? 0) - (event.process.data?.arrival ?? 0)
    );
    const mean = waits.reduce((sum, wait) => sum + wait, 0) / waits.length;

    console.log(
      `${side}: ${waits.length} jobs done, mean wait ${
        mean.toFixed(1)
      }, max wait ${Math.max(...waits)}, ended at ${result.currentTime}`,
    );
  }
}
