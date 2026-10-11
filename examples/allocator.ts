import { randomIntegerBetween, randomSeeded } from "@std/random";

import type {
  DisciplineComparator,
  DisciplineDefinition,
  ProcessDefinition,
  Simulation,
  StateData,
} from "../mod.ts";
import {
  continueEvent,
  createEvent,
  getWhere,
  initializeSimulation,
  initializeStore,
  put,
  registerDiscipline,
  registerPredicate,
  registerProcess,
  registerStore,
  reorderStore,
  runSimulation,
  scheduleEvent,
} from "../mod.ts";

/**
 * A training cluster with 4 CPUs and 2 GPUs: each job needs some of both, held for its whole duration.
 * An allocator owns the units and decides alone. Submitted jobs wait in a store used as a task queue; the allocator takes the best one that fits in what is free, all at once, and starts it with its units.
 * A finished job hands its units back through the same store: one blocking request per step, and nothing is held while waiting for the rest.
 * The queue discipline is the scheduling policy. At t=15 jobs are piling up: the run is paused, then resumed once per policy, from the same state.
 *
 * deno run examples/allocator.ts
 *
 * Expected output:
 *
 * Paused at 15: 7 jobs queued
 * first come, first served: 30 jobs done, mean wait 13.5, max wait 32, ended at 67, CPU 96%, GPU 65%
 * shortest job first: 30 jobs done, mean wait 11.7, max wait 47, ended at 70, CPU 91%, GPU 62%
 */

interface Units {
  cpus: string[];
  gpus: string[];
}

type Job = {
  job: number;
  submitted: number;
  cpus: number;
  gpus: number;
  duration: number;
};

/** The jobs to submit, and the next one to go */
type Workload = {
  jobs: Job[];
  next: number;
};

type Running = Job & {
  held: Units;
  start: number;
};

/** The units a finished job hands back */
type Release = {
  released: Units;
};

/** What goes through the queue: a job to run, or units handed back */
type Message = Job | Release;

interface Allocator extends StateData {
  free: Units;
}

type Stores = { queue: Message; done: Running };

const submit: ProcessDefinition<{ submit: Workload }, Stores> = {
  type: "submit",
  initial: "submit",
  steps: {
    submit(sim, event, state) {
      const { jobs, next } = state.data;

      // `step` is not passed on: sound as the queue is never full
      const { resume, finish } = put(sim, event, "queue", jobs[next]);

      // One arrival at a time: the process sleeps until the next job is submitted, and ends after the last one
      const following = jobs.at(next + 1);

      return {
        state: { ...state, data: { jobs, next: next + 1 } },
        next: [
          ...(resume ?? []),
          ...(following ? [continueEvent(event, following.submitted)] : []),
        ],
        finish,
      };
    },
  },
};

const allocator: ProcessDefinition<
  {
    wait: Allocator;
    serve: Allocator;
  },
  Stores,
  { serve: Message }
> = {
  type: "allocator",
  initial: "wait",
  steps: {
    wait(sim, event, state) {
      // Units handed back, or the best queued job that fits: the request carries the allocator's data, for the predicate to compare
      const { step, resume, finish } = getWhere(sim, event, "queue", "fits");

      return {
        state: { ...state, step: "serve" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    serve(sim, event, state) {
      const { free } = state.data;
      const message = event.process.data;

      // A job is over: its units are free again
      if ("released" in message) {
        const { released } = message;
        const back: Units = {
          cpus: [...free.cpus, ...released.cpus],
          gpus: [...free.gpus, ...released.gpus],
        };

        return {
          state: { ...state, step: "wait", data: { free: back } },
          next: [continueEvent(event, sim.currentTime)],
        };
      }

      // A job fits: start it, as a new process, with everything it needs
      const job = message;
      const held: Units = {
        cpus: free.cpus.slice(0, job.cpus),
        gpus: free.gpus.slice(0, job.gpus),
      };
      const left: Units = {
        cpus: free.cpus.slice(job.cpus),
        gpus: free.gpus.slice(job.gpus),
      };

      return {
        state: { ...state, step: "wait", data: { free: left } },
        next: [
          createEvent({
            scheduledAt: sim.currentTime,
            process: {
              type: "job",
              data: { ...job, held, start: sim.currentTime },
            },
          }),
          continueEvent(event, sim.currentTime),
        ],
      };
    },
  },
};

const job: ProcessDefinition<{
  run: Running;
  finish: Running;
}, Stores> = {
  type: "job",
  initial: "run",
  steps: {
    run(sim, event, state) {
      return {
        state: { ...state, step: "finish" },
        next: [continueEvent(event, sim.currentTime + state.data.duration)],
      };
    },
    finish(sim, event, state) {
      // Two store operations in one step: only their `resume` and `finish` are passed on, the job ends here
      // Sound as neither store is ever full
      const over = [
        put(sim, event, "queue", { released: state.data.held }),
        put(sim, event, "done", state.data),
      ];

      return {
        state,
        next: over.flatMap(({ resume }) => resume ?? []),
        finish: over.flatMap(({ finish }) => finish ?? []),
      };
    },
  },
};

/** How long a message keeps units busy: nothing for units handed back */
const duration = (message?: Message): number =>
  message && "duration" in message ? message.duration : 0;

/** Units handed back come first, whatever the policy */
const releasedFirst: DisciplineComparator<Message> = (a, b) =>
  Number(duration(b.event.process.data) === 0) -
  Number(duration(a.event.process.data) === 0);

/** The two policies, registered under the key the queue points to */
const policies: Record<string, DisciplineDefinition<"policy", Message>> = {
  "first come, first served": {
    type: "policy",
    comparator: (a, b) => releasedFirst(a, b) || a.seq - b.seq,
  },
  "shortest job first": {
    type: "policy",
    comparator: (a, b) =>
      releasedFirst(a, b) ||
      duration(a.event.process.data) - duration(b.event.process.data) ||
      a.seq - b.seq,
  },
};

/** Metrics of a finished run, read from the `done` store */
function report(
  policy: string,
  result: Simulation,
  total: Record<keyof Units, number>,
): string {
  const jobs = result.stores["done"].buffer.entries.map(({ event }) =>
    event.process.data
  );

  const waits = jobs.map((job) =>
    Number(job?.["start"]) - Number(job?.["submitted"])
  );
  const mean = waits.reduce((sum, wait) => sum + wait, 0) / waits.length;

  // Share of the unit-time in use, over the whole run
  const use = (kind: keyof Units) =>
    100 * jobs.reduce(
      (sum, job) => sum + Number(job?.[kind]) * Number(job?.["duration"]),
      0,
    ) / (total[kind] * result.currentTime);

  return `${policy}: ${jobs.length} jobs done, mean wait ${
    mean.toFixed(1)
  }, max wait ${Math.max(...waits)}, ended at ${result.currentTime}, CPU ${
    use("cpus").toFixed(0)
  }%, GPU ${use("gpus").toFixed(0)}%`;
}

if (import.meta.main) {
  const sim = initializeSimulation();

  sim.disciplines = registerDiscipline(
    sim,
    policies["first come, first served"],
  );

  // A job fits if what is free, carried by the allocator's request, covers what it needs
  sim.predicates = registerPredicate<Message, "fits", Allocator>(sim, {
    type: "fits",
    predicate: ({ process: { data: message } }, { process: { data } }) =>
      message !== undefined && data !== undefined && (
        "released" in message ||
        message.cpus <= data.free.cpus.length &&
          message.gpus <= data.free.gpus.length
      ),
  });

  sim.stores = registerStore<Message>(
    sim,
    initializeStore({
      id: "queue",
      capacity: Number.MAX_SAFE_INTEGER,
      discipline: "policy",
    }),
  );
  sim.stores = registerStore<Running>(
    sim,
    initializeStore({ id: "done", capacity: Number.MAX_SAFE_INTEGER }),
  );

  sim.processes = registerProcess(sim, submit);
  sim.processes = registerProcess(sim, allocator);
  sim.processes = registerProcess(sim, job);

  const free: Units = {
    cpus: ["cpu1", "cpu2", "cpu3", "cpu4"],
    gpus: ["gpu1", "gpu2"],
  };
  sim.timeline = scheduleEvent(
    sim,
    createEvent({
      scheduledAt: 0,
      process: { type: "allocator", data: { free } },
    }),
  );

  // The workload is drawn up front: nothing random is left for the runs, which all see the same jobs
  const prng = randomSeeded(1n);
  const workload: Job[] = Array.from({ length: 3000 }, (_, i) => ({
    job: i + 1,
    submitted: i,
    cpus: randomIntegerBetween(1, 2, { prng }),
    gpus: randomIntegerBetween(0, 1, { prng }),
    duration: randomIntegerBetween(2, 12, { prng }),
  }));
  sim.timeline = scheduleEvent(
    sim,
    createEvent({
      scheduledAt: 0,
      process: { type: "submit", data: { jobs: workload, next: 0 } },
    }),
  );

  const { result: paused } = await runSimulation(sim, {
    until: (_sim, next) => next.scheduledAt > 15,
  });

  console.log(
    `Paused at ${paused.currentTime}: ${
      paused.stores["queue"].buffer.entries.length
    } jobs queued`,
  );

  // One run per policy, each from a copy of the paused state: its own discipline, and the jobs already queued reordered under it
  for (const [name, policy] of Object.entries(policies)) {
    const swapped: Simulation = {
      ...paused,
      disciplines: registerDiscipline(paused, policy),
    };
    const branch: Simulation = {
      ...swapped,
      stores: reorderStore(swapped, "queue"),
    };

    const { result } = await runSimulation(branch);

    console.log(
      report(name, result, {
        cpus: free.cpus.length,
        gpus: free.gpus.length,
      }),
    );
  }
}
