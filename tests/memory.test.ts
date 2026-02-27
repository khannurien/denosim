import { assert, assertEquals } from "@std/assert";

import {
  applyDelta,
  createDelta,
  createDeltaEncodedSimulation,
  pruneWorkingState,
  reconstructFromDeltas,
} from "../src/memory.ts";
import {
  Event,
  EventState,
  EventTransition,
  ProcessDefinition,
  QueueDiscipline,
  StateData,
} from "../src/model.ts";
import { registerStore } from "../src/resources.ts";
import { runSimulationWithDeltas } from "../src/runner.ts";
import {
  createEvent,
  initializeSimulation,
  registerProcess,
  scheduleEvent,
} from "../src/simulation.ts";

Deno.test("createDelta captures new events and their initial status", () => {
  const sim1 = initializeSimulation();
  const e1 = createEvent({ scheduledAt: 0 });
  sim1.timeline = scheduleEvent(sim1, e1);

  const sim2 = initializeSimulation();
  const e2 = createEvent({ scheduledAt: 2 });
  sim2.timeline = scheduleEvent(sim2, e2);
  sim2.currentTime = 2;

  const delta = createDelta(sim1, sim2);
  assertEquals(delta.c, 2);
  // e2 is new in sim2 → captured in e ops
  assertEquals(delta.e.length, 1);
  assert(delta.e.some((op) => op.op === "set" && op.key === e2.id));
  // e2's Scheduled status is also new → captured in es ops
  assertEquals(delta.es.length, 1);
  assert(delta.es.some((op) => op.op === "set" && op.key === e2.id));
});

Deno.test("createDelta captures status transition and state mutations", async () => {
  const sim = initializeSimulation();

  const traced: ProcessDefinition<{ run: StateData }> = {
    type: "traced",
    initial: "run",
    steps: {
      run: (_sim, _event, state) => ({ state, next: [] }),
    },
  };
  sim.registry = registerProcess(sim, traced);

  const e = createEvent({
    scheduledAt: 0,
    process: { type: "traced", data: { value: 7 } },
  });
  sim.timeline = scheduleEvent(sim, e);

  // Snapshot before running (event is Scheduled, no process state yet)
  const prev = {
    ...sim,
    timeline: { ...sim.timeline },
    state: { ...sim.state },
  };

  const { result } = await runSimulationWithDeltas(sim);
  const next = result.current;

  const delta = createDelta(prev, next);

  assertEquals(delta.c, 0);
  assertEquals(delta.e.length, 0); // event was already in prev
  assertEquals(delta.es.length, 1); // Scheduled → Finished
  assertEquals(delta.es[0].key, e.id);
  assertEquals(delta.es[0].status, EventState.Finished);
  assertEquals(delta.et.length, 1); // Finished transition appended
  assertEquals(delta.et[0].transition.id, e.id);
  assertEquals(delta.et[0].transition.state, EventState.Finished);
  assertEquals(delta.s.length, 1); // process state set for the event
  assertEquals(delta.s[0].key, e.id);
});

Deno.test("delta encoding roundtrip reconstructs final state", () => {
  const sim0 = initializeSimulation();
  const sim1 = initializeSimulation();
  sim1.currentTime = 1;
  const sim2 = initializeSimulation();
  sim2.currentTime = 2;

  const encoded = createDeltaEncodedSimulation([sim0, sim1, sim2]);
  const recovered = reconstructFromDeltas(encoded.base, encoded.deltas);

  assertEquals(recovered.length, 3);
  assertEquals(recovered[2].currentTime, 2);
});

Deno.test("applyDelta applies store set operations", () => {
  const base = initializeSimulation();
  const req = createEvent({ scheduledAt: 0 });
  base.stores = {
    s1: {
      id: "s1",
      capacity: 1,
      blocking: true,
      discipline: QueueDiscipline.LIFO,
      buffer: [],
      getRequests: [req],
      putRequests: [],
    },
  };

  const result = applyDelta(base, {
    c: 1,
    e: [],
    es: [],
    et: [],
    s: [],
    st: [
      {
        op: "set",
        key: "s2",
        value: {
          id: "s2",
          capacity: 2,
          blocking: false,
          discipline: QueueDiscipline.FIFO,
          buffer: [],
          getRequests: [],
          putRequests: [],
        },
      },
    ],
  });

  assertEquals(result.currentTime, 1);
  assert(result.stores["s2"]);
});

Deno.test("runSimulation records only real steps and keeps full final state after dumps", async () => {
  const dir = "runs/test/dumps-cadence";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();

  const initial: Event[] = [];

  for (const t of [0, 1, 2, 3, 4]) {
    const event = createEvent({ scheduledAt: t });
    initial.push(event);
    sim.timeline = scheduleEvent(sim, event);
  }

  const { result } = await runSimulationWithDeltas(sim, {
    runDirectory: dir,
    dumpInterval: 2,
  });

  assertEquals(result.current.currentTime, 4);
  assert(
    initial.every((event) =>
      result.current.timeline.status[event.id] === EventState.Finished
    ),
  );
  assertEquals(result.deltas.length, 0);

  const dump0 = await Deno.stat(`${dir}/dumps/0-t1.json`);
  const dump1 = await Deno.stat(`${dir}/dumps/1-t3.json`);
  assert(dump0.isFile);
  assert(dump1.isFile);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("pruneWorkingState filters out finished events and their transitions", () => {
  const sim = initializeSimulation();

  // Create events with different states
  const finishedEvent = createEvent({ scheduledAt: 0 });
  const waitingEvent = createEvent({ scheduledAt: 1 });

  sim.timeline = scheduleEvent(sim, finishedEvent);
  sim.timeline = scheduleEvent(sim, waitingEvent);

  // Set up states and transitions
  sim.state[finishedEvent.id] = { type: "p", step: "done", data: {} };
  sim.state[waitingEvent.id] = { type: "p", step: "waiting", data: {} };

  sim.timeline.status[finishedEvent.id] = EventState.Finished;
  sim.timeline.status[waitingEvent.id] = EventState.Waiting;

  sim.timeline.transitions = [
    { id: finishedEvent.id, state: EventState.Scheduled, at: 0 },
    { id: finishedEvent.id, state: EventState.Finished, at: 1 },
    { id: waitingEvent.id, state: EventState.Scheduled, at: 1 },
    { id: waitingEvent.id, state: EventState.Waiting, at: 2 },
  ];

  const pruned = pruneWorkingState(sim);

  // Finished event should be removed from events
  assert(!pruned.timeline.events[finishedEvent.id]);

  // Waiting event should remain
  assert(pruned.timeline.events[waitingEvent.id]);

  // Finished event should be removed from status
  assert(!pruned.timeline.status[finishedEvent.id]);

  // Waiting event status should remain
  assertEquals(pruned.timeline.status[waitingEvent.id], EventState.Waiting);

  // Transitions for finished event should be filtered out
  const finishedTransitions = pruned.timeline.transitions.filter((
    t: EventTransition,
  ) => t.id === finishedEvent.id);
  assertEquals(finishedTransitions.length, 0);

  // Transitions for waiting event should remain
  const waitingTransitions = pruned.timeline.transitions.filter((
    t: EventTransition,
  ) => t.id === waitingEvent.id);
  assertEquals(waitingTransitions.length, 2);
});

Deno.test("pruneWorkingState preserves state only for events with parent references", () => {
  const sim = initializeSimulation();

  // Create parent-child relationship
  const parentEvent = createEvent({ scheduledAt: 0 });
  const childEvent = createEvent({
    scheduledAt: 1,
    parent: parentEvent.id,
    process: { type: "test", inheritStep: true },
  });

  sim.timeline = scheduleEvent(sim, parentEvent);
  sim.timeline = scheduleEvent(sim, childEvent);

  // Set up states
  sim.state[parentEvent.id] = { type: "p", step: "parent", data: {} };
  sim.state[childEvent.id] = { type: "p", step: "child", data: {} };

  // Mark parent as finished, child as waiting
  sim.timeline.status[parentEvent.id] = EventState.Finished;
  sim.timeline.status[childEvent.id] = EventState.Waiting;

  const pruned = pruneWorkingState(sim);

  // Parent should be removed (finished)
  assert(!pruned.timeline.events[parentEvent.id]);
  assert(!pruned.timeline.status[parentEvent.id]);

  // Child should remain (not finished)
  assert(pruned.timeline.events[childEvent.id]);
  assertEquals(pruned.timeline.status[childEvent.id], EventState.Waiting);

  // Parent's state should be preserved because child references it
  assert(pruned.state[parentEvent.id]);
  assertEquals(pruned.state[parentEvent.id].step, "parent");

  // Child's state is not preserved because no other events reference it
  // (only parent references are tracked for state preservation)
  assert(!pruned.state[childEvent.id]);
});

Deno.test("pruneWorkingState handles complex parent-child relationships", () => {
  const sim = initializeSimulation();

  // Create a chain: grandparent -> parent -> child
  const grandparent = createEvent({ scheduledAt: 0 });
  const parent = createEvent({
    scheduledAt: 1,
    parent: grandparent.id,
    process: { type: "test", inheritStep: true },
  });
  const child = createEvent({
    scheduledAt: 2,
    parent: parent.id,
    process: { type: "test", inheritStep: true },
  });

  sim.timeline = scheduleEvent(sim, grandparent);
  sim.timeline = scheduleEvent(sim, parent);
  sim.timeline = scheduleEvent(sim, child);

  // Set up states
  sim.state[grandparent.id] = { type: "p", step: "grandparent", data: {} };
  sim.state[parent.id] = { type: "p", step: "parent", data: {} };
  sim.state[child.id] = { type: "p", step: "child", data: {} };

  // Mark grandparent and parent as finished, child as waiting
  sim.timeline.status[grandparent.id] = EventState.Finished;
  sim.timeline.status[parent.id] = EventState.Finished;
  sim.timeline.status[child.id] = EventState.Waiting;

  const pruned = pruneWorkingState(sim);

  // Grandparent should be removed
  assert(!pruned.timeline.events[grandparent.id]);

  // Parent should be removed
  assert(!pruned.timeline.events[parent.id]);

  // Child should remain
  assert(pruned.timeline.events[child.id]);

  // Parent's state should be preserved (directly referenced by child)
  assert(pruned.state[parent.id]);
  assertEquals(pruned.state[parent.id].step, "parent");

  // Grandparent's state should NOT be preserved (not directly referenced by child)
  assert(!pruned.state[grandparent.id]);

  // Child's state should NOT be preserved (no other events reference it)
  assert(!pruned.state[child.id]);
});

Deno.test("runSimulation keeps base immutable and reconstructs current from deltas", async () => {
  const dir = "runs/test/dumps-immutability";
  await Deno.remove(dir, { recursive: true }).catch(() => {});

  const sim = initializeSimulation();

  const event = createEvent({ scheduledAt: 0 });
  sim.timeline = scheduleEvent(sim, event);

  const { result } = await runSimulationWithDeltas(sim, {
    runDirectory: dir,
    dumpInterval: 100,
  });

  assertEquals(Object.keys(result.base.timeline.events).length, 1);
  assertEquals(result.base.timeline.status[event.id], EventState.Scheduled);
  assertEquals(Object.keys(result.base.state).length, 0);

  const replay = reconstructFromDeltas(result.base, result.deltas);
  const replayStop = replay[replay.length - 1];
  assertEquals(replayStop, result.current);
  assertEquals(replayStop.timeline.status[event.id], EventState.Finished);
  assertEquals(Object.keys(replayStop.state).length, 1);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkpoints preserve full replay state by default", async () => {
  const sim = initializeSimulation();
  const req1 = createEvent({ scheduledAt: 0 });
  const req2 = createEvent({ scheduledAt: 0 });
  sim.stores = registerStore(sim, {
    id: "s1",
    capacity: 1,
    blocking: true,
    discipline: QueueDiscipline.FIFO,
    buffer: [],
    getRequests: [req1],
    putRequests: [req2],
  });
  const e1 = createEvent({ scheduledAt: 0 });
  const e2 = createEvent({ scheduledAt: 1 });
  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);

  const dir = "runs/test/dumps-checkpoint-compact";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const { result } = await runSimulationWithDeltas(sim, {
    runDirectory: dir,
    dumpInterval: 1,
  });
  const stop = result.current;

  assertEquals(Object.keys(stop.timeline.events).length, 2);
  assertEquals(stop.timeline.status[e1.id], EventState.Finished);
  assertEquals(stop.timeline.status[e2.id], EventState.Finished);
  assertEquals(Object.keys(stop.state).length, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("checkpoints keep untilEvent semantics with full replay state", async () => {
  const sim = initializeSimulation();
  const e1 = createEvent({ scheduledAt: 10 });
  const e2 = createEvent({ scheduledAt: 20 });
  const e3 = createEvent({ scheduledAt: 30 });
  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);
  sim.timeline = scheduleEvent(sim, e3);

  const dir = "runs/test/dumps-checkpoint-until-event";
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const { result, stats } = await runSimulationWithDeltas(sim, {
    untilEvent: e2,
    runDirectory: dir,
    dumpInterval: 1,
  });
  const stop = result.current;

  assertEquals(stats.end, 20);
  const handledE1 = Object.values(stop.timeline.events).find((event) =>
    event.id === e1.id
  );
  const handledE2 = Object.values(stop.timeline.events).find((event) =>
    event.id === e2.id
  );
  assert(handledE1);
  assert(handledE2);
  assertEquals(stop.timeline.status[handledE1.id], EventState.Finished);
  assertEquals(stop.timeline.status[handledE2.id], EventState.Finished);
  const remaining = Object.values(stop.timeline.events).find((event) =>
    event.id === e3.id
  );
  assert(remaining);
  assertEquals(stop.timeline.status[remaining.id], EventState.Scheduled);
  await Deno.remove(dir, { recursive: true });
});
