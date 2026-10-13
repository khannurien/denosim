import type {
  Event,
  ProcessDefinition,
  Simulation,
  StateData,
} from "../mod.ts";
import {
  cancel,
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
 * A support line with one agent: callers wait for the agent, and give up when their patience runs out.
 * Waiting for whichever comes first is a fork: a request on the store, and a timeout.
 * The first one cancels the other: `finish` for the timeout, `cancel` for the request.
 * Cleo's patience runs out at the very time the agent is handed to her: her timeout stands down.
 *
 * deno run examples/reneging.ts
 *
 * Expected output:
 *
 * [0] Ada calls
 * [0] Ada talks to Sam
 * [1] Bob calls
 * [2] Cleo calls
 * [3] Bob gives up
 * [4] Dan calls
 * [5] Ada hangs up
 * [5] Cleo talks to Sam
 * [6] Dan gives up
 * [7] Cleo hangs up
 * Simulation ended at 7
 */

interface Agent extends StateData {
  agent: string;
}

interface Caller extends StateData {
  caller: string;
  patience: number;
  minutes: number;
}

/** A caller on hold keeps both sides of the fork, to cancel the one that comes second */
interface Holding extends Caller {
  request: Event;
  timeout: Event;
}

type Stores = { agents: Agent };

const caller: ProcessDefinition<
  {
    call: Caller;
    answer: Holding;
    hangup: Caller & Agent;
  },
  Stores,
  { answer: Agent | undefined },
  "call"
> = {
  type: "caller",
  initial: "call",
  steps: {
    call(sim, event, state) {
      console.log(`[${sim.currentTime}] ${state.data.caller} calls`);

      // Fork: the next step runs on the agent or on the timeout, whichever comes first
      const { step: request, resume, finish } = get(sim, event, "agents");
      const timeout = continueEvent(
        event,
        sim.currentTime + state.data.patience,
      );

      return {
        state: {
          ...state,
          step: "answer",
          data: { ...state.data, request, timeout },
        },
        next: resume ? [request, timeout, ...resume] : [request, timeout],
        finish,
      };
    },
    answer(sim, event, state) {
      const { caller, minutes, request, timeout } = state.data;
      const item = event.process.data;

      // The agent came first, with the event: cancel the timeout
      if (item) {
        const { agent } = item;
        console.log(`[${sim.currentTime}] ${caller} talks to ${agent}`);

        return {
          state: { ...state, step: "hangup", data: { ...state.data, agent } },
          next: [continueEvent(event, sim.currentTime + minutes)],
          finish: [timeout],
        };
      }

      // The timeout came first: withdraw the request, or the agent would later be handed to a caller who left
      const withdrawn = cancel(sim, event, "agents", request);

      // Request served at this very time: stand down, the other continuation carries on
      if (!withdrawn) return { state, next: [] };

      console.log(`[${sim.currentTime}] ${caller} gives up`);

      return { state, next: [], finish: withdrawn.finish };
    },
    hangup(sim, event, state) {
      console.log(`[${sim.currentTime}] ${state.data.caller} hangs up`);

      // `step` is not passed on, the caller ends here: sound as the store is never full
      const { resume, finish } = put(sim, event, "agents", {
        agent: state.data.agent,
      });

      return { state, next: resume ?? [], finish };
    },
  },
};

if (import.meta.main) {
  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: { agents: initializeStore({ capacity: 1 }) },
  };
  put(sim, createEvent({ scheduledAt: 0 }), "agents", { agent: "Sam" });

  sim.processes = registerProcess(sim, caller);

  const callers = [
    { at: 0, caller: "Ada", patience: 2, minutes: 5 },
    { at: 1, caller: "Bob", patience: 2, minutes: 3 },
    { at: 2, caller: "Cleo", patience: 3, minutes: 2 },
    { at: 4, caller: "Dan", patience: 2, minutes: 4 },
  ];
  for (const { at, ...data } of callers) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: at, process: { type: caller, data: data } }),
    );
  }

  const { result } = await runSimulation(sim);

  console.log(`Simulation ended at ${result.currentTime}`);
}
