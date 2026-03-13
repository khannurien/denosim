import { randomIntegerBetween, randomSeeded } from "@std/random";

import type { ProcessDefinition, StateData } from "../src/model.ts";
import {
  continueEvent,
  get,
  getWhere,
  initializeStore,
  put,
  registerStore,
} from "../src/resources.ts";
import { runSimulation } from "../src/runner.ts";
import {
  createEvent,
  initializeSimulation,
  registerDiscipline,
  registerPredicate,
  registerProcess,
  scheduleEvent,
} from "../src/simulation.ts";

/**
 * Task scheduler showcase:
 * - `registerDiscipline`: EDF (earliest-deadline-first) ordering on the task queue;
 * - `registerPredicate` + `getWhere`: sync-workers selectively dequeue only sync tasks;
 * - `get`: any-worker serves all remaining tasks in EDF order.
 *
 * Two dedicated sync-workers and one general any-worker pull from a shared non-blocking queue.
 * Because sync tasks have their own workers, they see lower wait times; EDF on the general worker keeps deadline misses low for the async tasks that spill over.
 */

const SIM_TIME = 3000;
const QUEUE_ID = "tasks" as const;
const EDF = "EDF" as const;
const IS_SYNC = "isSync" as const;

type Kind = "sync" | "async";

interface Task extends StateData {
  taskId: number;
  kind: Kind;
  deadline: number;
  arrivalAt: number;
  serviceTime: number;
}

interface GeneratorState extends StateData {
  nextId: number;
}

interface WorkerBase extends StateData {
  workerId: string;
  processed: number;
}

type WorkerWorking = WorkerBase & Partial<Task>;

interface CompletedTask {
  taskId: number;
  kind: Kind;
  arrivalAt: number;
  startAt: number;
  finishAt: number;
  deadline: number;
  workerKind: "sync-worker" | "any-worker";
}

function mean(xs: number[]): string {
  return xs.length === 0
    ? "—"
    : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
}

function pct(xs: number[], p: number): string {
  if (xs.length === 0) return "—";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)].toFixed(1);
}

if (import.meta.main) {
  const prng = randomSeeded(42n);
  const sim = initializeSimulation();

  /** EDF discipline: tasks ordered by deadline */
  sim.disciplines = registerDiscipline<Task>(sim, {
    type: EDF,
    comparator: (a, b) => {
      const da = a.event.process.data?.deadline ?? Infinity;
      const db = b.event.process.data?.deadline ?? Infinity;
      return da - db;
    },
  });

  sim.predicates = registerPredicate(sim, {
    type: IS_SYNC,
    predicate: (d: Task) => d.kind === "sync",
  });

  // Shared task queue: non-blocking, EDF
  const queue = initializeStore<Task>({
    id: QUEUE_ID,
    blocking: false,
    capacity: Number.MAX_SAFE_INTEGER,
    discipline: EDF,
  });
  sim.stores = registerStore<Task>(sim, queue);

  // Handled tasks
  const completed: CompletedTask[] = [];

  // Process: creates tasks at random intervals
  const generator: ProcessDefinition<{ run: GeneratorState }> = {
    type: "generator",
    initial: "run",
    steps: {
      run(sim, event, state) {
        const kind: Kind = randomIntegerBetween(1, 10, { prng }) <= 4
          ? "sync"
          : "async";
        const serviceTime = randomIntegerBetween(3, 10, { prng });
        const deadline = sim.currentTime +
          randomIntegerBetween(15, 45, { prng });

        const task: Task = {
          taskId: state.data.nextId,
          kind,
          deadline,
          arrivalAt: sim.currentTime,
          serviceTime,
        };

        // Use a dummy "none" event as the producer so the put's own continuation (step) carries the correct process type and can be safely discarded
        // We only need `resume` (wakeup for a blocked worker) and `finish` (cleanup of the old waiting placeholder)
        // `step` is skipped because the generator schedules its own next arrival event instead
        const putEvent = createEvent({
          scheduledAt: sim.currentTime,
          process: { type: "none" },
        });
        const { resume, finish } = put(sim, putEvent, QUEUE_ID, task);

        const nextId = state.data.nextId + 1;
        const nextAt = sim.currentTime + randomIntegerBetween(2, 5, { prng });
        const nextArrival = nextAt <= SIM_TIME
          ? [continueEvent(event, nextAt, { nextId })]
          : [];

        return {
          state: { ...state, data: { nextId } },
          next: resume ? [...resume, ...nextArrival] : nextArrival,
          finish: finish ?? [],
        };
      },
    },
  };

  // Process: dequeues (EDF) sync tasks only using getWhere
  const syncWorker: ProcessDefinition<
    { idle: WorkerBase; working: WorkerWorking }
  > = {
    type: "sync-worker",
    initial: "idle",
    steps: {
      idle(sim, event, state) {
        const { step } = getWhere(sim, event, QUEUE_ID, IS_SYNC);
        return {
          state: { ...state, step: "working" },
          next: [step],
        };
      },
      working(sim, event, state) {
        const d = state.data;
        const startAt = sim.currentTime;
        const finishAt = startAt + (d.serviceTime ?? 1);

        completed.push({
          taskId: d.taskId!,
          kind: d.kind!,
          arrivalAt: d.arrivalAt!,
          startAt,
          finishAt,
          deadline: d.deadline!,
          workerKind: "sync-worker",
        });

        return {
          state: {
            ...state,
            step: "idle",
            data: { workerId: d.workerId, processed: (d.processed ?? 0) + 1 },
          },
          next: [createEvent({
            parent: event.id,
            scheduledAt: finishAt,
            process: {
              type: "sync-worker",
              data: { workerId: d.workerId, processed: (d.processed ?? 0) + 1 },
            },
          })],
        };
      },
    },
  };

  // Process: dequeues (EDF) any task using get
  const anyWorker: ProcessDefinition<
    { idle: WorkerBase; working: WorkerWorking }
  > = {
    type: "any-worker",
    initial: "idle",
    steps: {
      idle(sim, event, state) {
        const { step } = get(sim, event, QUEUE_ID);
        return {
          state: { ...state, step: "working" },
          next: [step],
        };
      },
      working(sim, event, state) {
        const d = state.data;
        const startAt = sim.currentTime;
        const finishAt = startAt + (d.serviceTime ?? 1);

        completed.push({
          taskId: d.taskId!,
          kind: d.kind!,
          arrivalAt: d.arrivalAt!,
          startAt,
          finishAt,
          deadline: d.deadline!,
          workerKind: "any-worker",
        });

        return {
          state: {
            ...state,
            step: "idle",
            data: { workerId: d.workerId, processed: (d.processed ?? 0) + 1 },
          },
          next: [createEvent({
            parent: event.id,
            scheduledAt: finishAt,
            process: {
              type: "any-worker",
              data: { workerId: d.workerId, processed: (d.processed ?? 0) + 1 },
            },
          })],
        };
      },
    },
  };

  sim.processes = registerProcess(sim, generator);
  sim.processes = registerProcess(sim, syncWorker);
  sim.processes = registerProcess(sim, anyWorker);

  sim.timeline = scheduleEvent(
    sim,
    createEvent({
      scheduledAt: 0,
      process: { type: "generator", data: { nextId: 1 } },
    }),
  );

  for (let i = 1; i <= 2; i++) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({
        scheduledAt: 0,
        process: {
          type: "sync-worker",
          data: { workerId: `sync-${i}`, processed: 0 },
        },
      }),
    );
  }

  for (let i = 1; i <= 1; i++) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({
        scheduledAt: 0,
        process: {
          type: "any-worker",
          data: { workerId: `any-${i}`, processed: 0 },
        },
      }),
    );
  }

  const stop = createEvent({ scheduledAt: SIM_TIME });
  sim.timeline = scheduleEvent(sim, stop);

  const { stats } = await runSimulation(sim, { untilEvent: stop });

  const sync = completed.filter((t) => t.kind === "sync");
  const async_ = completed.filter((t) => t.kind === "async");

  const wait = (t: CompletedTask) => t.startAt - t.arrivalAt;
  const lateness = (t: CompletedTask) => Math.max(0, t.finishAt - t.deadline);
  const missed = (ts: CompletedTask[]) =>
    ts.filter((t) => t.finishAt > t.deadline).length;

  const byWorker = (kind: Kind, wk: CompletedTask["workerKind"]) =>
    completed.filter((t) => t.kind === kind && t.workerKind === wk).length;

  console.log(
    `Simulation ran for ${SIM_TIME} time units (wall: ${stats.duration} ms)`,
  );
  console.log(
    `Tasks completed: ${completed.length} (${sync.length} sync, ${async_.length} async)`,
  );
  console.log(
    `  sync tasks served by: ${byWorker("sync", "sync-worker")} sync-workers, ${
      byWorker("sync", "any-worker")
    } any-worker`,
  );
  console.log(
    `  async tasks served by: ${
      byWorker("async", "sync-worker")
    } sync-workers, ${byWorker("async", "any-worker")} any-worker`,
  );
  console.log();

  const headers = ["metric", "sync", "async"];
  const rows = [
    ["avg wait", mean(sync.map(wait)), mean(async_.map(wait))],
    ["p95 wait", pct(sync.map(wait), 95), pct(async_.map(wait), 95)],
    ["avg lateness", mean(sync.map(lateness)), mean(async_.map(lateness))],
    ["deadline misses", String(missed(sync)), String(missed(async_))],
  ];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const fmt = (cells: (string | number)[]) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(fmt(row));
}
