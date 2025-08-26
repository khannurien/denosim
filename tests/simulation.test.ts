import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createEvent,
  Event,
  EventState,
  initializeSimulation,
  ProcessDefinition,
  registerProcess,
  runSimulation,
  scheduleEvent,
  StateData,
} from "../mod.ts";

Deno.test("basic event scheduling", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  assertEquals(sim.events.length, 0);

  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 1);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events.length, 1);
  assertEquals(stop.events[0].finishedAt, 10);
  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("zero-duration events", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: sim.currentTime });
  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events[0].finishedAt, 0);
});

Deno.test("basic out of order scheduling", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  const e2 = createEvent(sim, { scheduledAt: 5 });
  const e3 = createEvent(sim, { scheduledAt: 15 });
  assertEquals(sim.events.length, 0);

  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e1);
  assertEquals(sim.events.length, 3);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events.length, 3);
  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("basic event ordering", async () => {
  const sim = initializeSimulation();

  const processedOrder: number[] = [];

  const foo: ProcessDefinition<{
    start: [StateData, []];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(_sim, event, state) {
        processedOrder.push(event.scheduledAt);

        return {
          updated: event,
          state: state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: 10, process: { type: "foo" } });
  const e2 = createEvent(sim, { scheduledAt: 0, process: { type: "foo" } });
  const e3 = createEvent(sim, { scheduledAt: 15, process: { type: "foo" } });
  const e4 = createEvent(sim, { scheduledAt: 5, process: { type: "foo" } });
  const e5 = createEvent(sim, { scheduledAt: 2, process: { type: "foo" } });
  const e6 = createEvent(sim, { scheduledAt: 50, process: { type: "foo" } });

  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e4);
  sim.events = scheduleEvent(sim, e5);
  sim.events = scheduleEvent(sim, e6);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(stop.events.length, 6);
  assertEquals(processedOrder, [0, 2, 5, 10, 15, 50]);
  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("scheduling events in the past", () => {
  const sim = initializeSimulation();

  const foo: ProcessDefinition<{
    start: [StateData, [StateData]];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const past = createEvent(sim, { scheduledAt: sim.currentTime - 1 });

        return {
          updated: event,
          state: state,
          next: [past],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: -1 });
  const e2 = createEvent(sim, { scheduledAt: 10, process: { type: "foo" } });

  assertThrows(() => {
    sim.events = scheduleEvent(sim, e1);
  });
  sim.events = scheduleEvent(sim, e2);

  assertRejects(async () => {
    const [_states, _stats] = await runSimulation(sim);
  });
});

Deno.test("event process scheduling", async () => {
  const sim = initializeSimulation();

  const results: Record<number, Event> = {};

  const foo: ProcessDefinition<{
    start: [StateData, []];
  }> = {
    type: "foo",
    initial: "start",
    steps: {
      start(sim, event, state) {
        results[sim.currentTime] = event;

        return {
          updated: event,
          state: state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: 10, process: { type: "foo" } });
  const e2 = createEvent(sim, { scheduledAt: 20, process: { type: "foo" } });
  const e3 = createEvent(sim, { scheduledAt: 30, process: { type: "foo" } });
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  assertEquals(sim.events.length, 3);

  const [states, _stats] = await runSimulation(sim);
  assert(states.length > 0);
  const stop = states[states.length - 1];

  assertEquals(results[10].id, e1.id);
  assertEquals(results[20].id, e2.id);
  assertEquals(results[30].id, e3.id);

  assert(stop.events.every((event) => event.status == EventState.Finished));
});

Deno.test("simulation until time condition", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  const e2 = createEvent(sim, { scheduledAt: 20 });
  const e3 = createEvent(sim, { scheduledAt: 30 });
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);

  const [states, stats] = await runSimulation(sim, { untilTime: 20 });

  assertEquals(stats.end, 20);

  assert(states.length > 0);
  const stop = states[states.length - 1];
  assertEquals(
    stop.events.find((event) => event.id === e1.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e2.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e3.id)?.status,
    EventState.Scheduled,
  );
});

Deno.test("simulation until event condition", async () => {
  const sim = initializeSimulation();

  const e1 = createEvent(sim, { scheduledAt: 10 });
  const e2 = createEvent(sim, { scheduledAt: 20 });
  const e3 = createEvent(sim, { scheduledAt: 30 });
  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);

  const [states, stats] = await runSimulation(sim, { untilEvent: e2 });

  assertEquals(stats.end, 20);

  assert(states.length > 0);
  const stop = states[states.length - 1];
  assertEquals(
    stop.events.find((event) => event.id === e1.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e2.id)?.status,
    EventState.Finished,
  );
  assertEquals(
    stop.events.find((event) => event.id === e3.id)?.status,
    EventState.Scheduled,
  );
});
