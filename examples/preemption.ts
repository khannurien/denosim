import type { Event, ProcessDefinition, StateData } from "../mod.ts";
import {
  cancel,
  continueEvent,
  createEvent,
  get,
  getWhere,
  initializeSimulation,
  initializeStore,
  put,
  registerDiscipline,
  registerPredicate,
  registerProcess,
  registerStore,
  runSimulation,
  scheduleEvent,
} from "../mod.ts";

/**
 * One CPU, tasks with priorities: the lower the value, the more urgent.
 * The CPU is the process; tasks are items in a `ready` store, ordered by priority then arrival.
 * While it runs a task, the CPU waits for whichever comes first: the end of the task, or a more urgent one.
 * A preempted task goes back to the store with the time it has left.
 *
 * deno run examples/preemption.ts
 *
 * Expected output:
 *
 * [0] backup arrives
 * [0] backup runs
 * [1] report arrives
 * [1] backup preempted by report, 9 left
 * [1] report runs
 * [3] keypress arrives
 * [3] report preempted by keypress, 2 left
 * [3] keypress runs
 * [4] keypress done
 * [4] report runs
 * [5] click arrives
 * [5] report preempted by click, 1 left
 * [5] click runs
 * [7] scroll arrives
 * [7] click done
 * [7] scroll runs
 * [8] scroll done
 * [8] report runs
 * [9] report done
 * [9] backup runs
 * [18] backup done
 * Simulation ended at 18
 */

interface Task extends StateData {
  task: string;
  priority: number;
  remaining: number;
}

interface Loaded extends StateData {
  running: Task;
}

/** A CPU running a task keeps both sides of the fork, to cancel the one that comes second */
interface Busy extends Loaded {
  since: number;
  timeout: Event;
  request: Event;
}

type Stores = { ready: Task; done: Task };

const cpu: ProcessDefinition<
  {
    idle: StateData;
    load: StateData;
    dispatch: Loaded;
    run: Busy;
  },
  Stores,
  { load: Task; run: Task | undefined }
> = {
  type: "cpu",
  initial: "idle",
  steps: {
    idle(sim, event, state) {
      const { step, resume, finish } = get(sim, event, "ready");

      return {
        state: { ...state, step: "load" },
        next: resume ? [step, ...resume] : [step],
        finish,
      };
    },
    load(sim, event, state) {
      // The task arrives with the event: kept in the data, where the next step and its request find it
      return {
        state: {
          ...state,
          step: "dispatch",
          data: { running: event.process.data },
        },
        next: [continueEvent(event, sim.currentTime)],
      };
    },
    dispatch(sim, event, state) {
      const { running } = state.data;
      console.log(`[${sim.currentTime}] ${running.task} runs`);

      const timeout = continueEvent(event, sim.currentTime + running.remaining);

      // Fork: the next step runs on the timeout or on a more urgent task, whichever comes first
      // The request carries the CPU's data, the task it runs, for the predicate to compare
      const { step: request, resume, finish } = getWhere(
        sim,
        event,
        "ready",
        "urgent",
      );

      return {
        state: {
          ...state,
          step: "run",
          data: {
            running,
            since: sim.currentTime,
            timeout,
            request,
          },
        },
        next: resume ? [request, timeout, ...resume] : [request, timeout],
        finish,
      };
    },
    run(sim, event, state) {
      const { running, since, timeout, request } = state.data;
      const urgent = event.process.data;

      if (!urgent) {
        // The task is over: withdraw the request for a more urgent one
        const withdrawn = cancel(sim, event, "ready", request);

        // Request served at this very time: stand down, the other continuation carries on
        if (!withdrawn) return { state, next: [] };

        console.log(`[${sim.currentTime}] ${running.task} done`);

        // `step` is not passed on, the CPU goes on with its own continuation: sound as the store is never full
        const done = put(sim, event, "done", { ...running, remaining: 0 });

        return {
          state: { ...state, step: "idle", data: {} },
          next: [continueEvent(event, sim.currentTime), ...done.resume ?? []],
          finish: [...withdrawn.finish ?? [], ...done.finish ?? []],
        };
      }

      // A more urgent task came first, with the event: cancel the timeout, the running task goes back with what it has left
      const left = running.remaining - (sim.currentTime - since);
      console.log(
        `[${sim.currentTime}] ${running.task} preempted by ${urgent.task}, ${left} left`,
      );

      // `step` is not passed on here either
      const back = left > 0
        ? put(sim, event, "ready", { ...running, remaining: left })
        : put(sim, event, "done", { ...running, remaining: 0 });

      return {
        state: {
          ...state,
          step: "dispatch",
          data: { running: urgent },
        },
        next: [continueEvent(event, sim.currentTime), ...back.resume ?? []],
        finish: [timeout, ...back.finish ?? []],
      };
    },
  },
};

const arrival: ProcessDefinition<{ arrive: Task }, Stores> = {
  type: "arrival",
  initial: "arrive",
  steps: {
    arrive(sim, event, state) {
      console.log(`[${sim.currentTime}] ${state.data.task} arrives`);

      // `step` is not passed on, the process ends here: sound as the store is never full
      const { resume, finish } = put(sim, event, "ready", state.data);

      return { state, next: resume ?? [], finish };
    },
  },
};

if (import.meta.main) {
  const sim = initializeSimulation();

  sim.disciplines = registerDiscipline<Task>(sim, {
    type: "priority",
    comparator: (a, b) =>
      (a.event.process.data?.priority ?? 0) -
        (b.event.process.data?.priority ?? 0) || a.seq - b.seq,
  });

  // More urgent than the task the CPU runs, carried by its request
  sim.predicates = registerPredicate<Task, "urgent", Loaded>(sim, {
    type: "urgent",
    predicate: (item, request) =>
      (item.process.data?.priority ?? 0) <
        (request.process.data?.running.priority ?? 0),
  });

  sim.stores = registerStore<Task>(
    sim,
    initializeStore({
      id: "ready",
      capacity: Number.MAX_SAFE_INTEGER,
      discipline: "priority",
    }),
  );
  sim.stores = registerStore<Task>(
    sim,
    initializeStore({ id: "done", capacity: Number.MAX_SAFE_INTEGER }),
  );

  sim.processes = registerProcess(sim, cpu);
  sim.processes = registerProcess(sim, arrival);

  sim.timeline = scheduleEvent(
    sim,
    createEvent({ scheduledAt: 0, process: { type: "cpu" } }),
  );

  const tasks = [
    { at: 0, task: "backup", priority: 2, remaining: 10 },
    { at: 1, task: "report", priority: 1, remaining: 4 },
    { at: 3, task: "keypress", priority: 0, remaining: 1 },
    { at: 5, task: "click", priority: 0, remaining: 2 },
    { at: 7, task: "scroll", priority: 0, remaining: 1 },
  ];
  for (const { at, ...data } of tasks) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: at, process: { type: "arrival", data } }),
    );
  }

  const { result } = await runSimulation(sim);

  console.log(`Simulation ended at ${result.currentTime}`);
}
