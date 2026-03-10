import { assert, assertEquals, assertThrows } from "@std/assert";

import type { ProcessDefinition, StateData, StoreID } from "../src/model.ts";
import { EventState, QueueDiscipline } from "../src/model.ts";
import {
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
  registerProcess,
  scheduleEvent,
} from "../src/simulation.ts";

interface FooData extends StateData {
  foo?: string;
  store: StoreID;
}

const prod: ProcessDefinition<{
  start: FooData;
  stop: FooData;
}> = {
  type: "prod",
  initial: "start",
  steps: {
    start(sim, event, state) {
      const { step, resume, finish } = put(sim, event, state.data["store"], {
        ...state.data,
      });

      return {
        state: { ...state, step: "stop" },
        next: resume ? [step, ...resume] : [step],
        finish: finish ?? [],
      };
    },
    stop(_sim, _event, state) {
      return {
        state,
        next: [],
      };
    },
  },
};

const cons: ProcessDefinition<{
  start: FooData;
  stop: FooData;
}> = {
  type: "cons",
  initial: "start",
  steps: {
    start(sim, event, state) {
      const { step, resume, finish } = get(sim, event, state.data["store"]);

      return {
        state: {
          ...state,
          data: { ...step.process.data ?? state.data },
          step: "stop",
        },
        next: resume ? [step, ...resume] : [step],
        finish: finish ?? [],
      };
    },
    stop(_sim, _event, state) {
      return {
        state,
        next: [],
      };
    },
  },
};

Deno.test("producer-consumer synchronization with blocking", async () => {
  const sim = initializeSimulation();

  const store = initializeStore({
    blocking: true,
  });

  sim.stores = registerStore(sim, store);

  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  const e1 = createEvent({
    scheduledAt: 0,
    process: { type: "prod", data: { store: store.id, foo: "bar" } },
  });

  const e2 = createEvent({
    scheduledAt: 5,
    process: { type: "cons", data: { store: store.id } },
  });

  const e3 = createEvent({
    scheduledAt: 10,
    process: { type: "cons", data: { store: store.id } },
  });

  const e4 = createEvent({
    scheduledAt: 15,
    process: { type: "prod", data: { store: store.id, foo: "baz" } },
  });

  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);
  sim.timeline = scheduleEvent(sim, e3);
  sim.timeline = scheduleEvent(sim, e4);

  const { result } = await runSimulation(sim);

  // Producer has been unblocked by consumer
  const prodBlocked = Object.values(result.timeline.events).find((event) =>
    event.id === e1.id
  );
  const prodBlockedFinished = [...result.timeline.transitions].reverse().find((
    transition,
  ) =>
    transition.id === prodBlocked?.id &&
    transition.state === EventState.Finished
  );
  assertEquals(prodBlockedFinished?.at, 0);
  const prodUnblocked = Object.values(result.timeline.events).find((event) =>
    event.parent && event.parent === e1.id && event.scheduledAt === 5
  );
  const prodUnblockedFinished = [...result.timeline.transitions].reverse().find(
    (
      transition,
    ) =>
      transition.id === prodUnblocked?.id &&
      transition.state === EventState.Finished,
  );
  assertEquals(prodUnblockedFinished?.at, 5);

  // Consumer has been unblocked by producer and has gotten the data
  const consBlocked = Object.values(result.timeline.events).find((event) =>
    event.id === e3.id
  );
  const consBlockedFinished = [...result.timeline.transitions].reverse().find((
    transition,
  ) =>
    transition.id === consBlocked?.id &&
    transition.state === EventState.Finished
  );
  assertEquals(consBlockedFinished?.at, 10);
  const consUnblocked = Object.values(result.timeline.events).find((event) =>
    event.parent && event.parent === e3.id && event.scheduledAt === 15
  );
  const consUnblockedFinished = [...result.timeline.transitions].reverse().find(
    (
      transition,
    ) =>
      transition.id === consUnblocked?.id &&
      transition.state === EventState.Finished,
  );
  assertEquals(consUnblockedFinished?.at, 15);
  assertEquals(consUnblocked!.process.data!["foo"], "baz");

  // All processes have reached their final step
  assert(Object.values(result.state).every((state) => state.step === "stop"));
});

Deno.test("multiple consumers with single producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });

  const waitA = get(sim, consumerA, store.id);
  const waitB = get(sim, consumerB, store.id);
  assert(waitA.step.waiting);
  assert(waitB.step.waiting);
  assertEquals(sim.stores[store.id].getRequests.length, 2);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });
  const putResult = put(sim, producer, store.id, { store: store.id, foo: "x" });

  assert(putResult.resume);
  assert(putResult.resume[0]);
  assertEquals(putResult.resume[0].parent, consumerA.id);
  assertEquals(sim.stores[store.id].getRequests.length, 1);
});

Deno.test("multiple producers with delayed consumers", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });

  const blockedA = put(sim, producerA, store.id, { store: store.id, foo: "A" });
  const blockedB = put(sim, producerB, store.id, { store: store.id, foo: "B" });
  assert(blockedA.step.waiting);
  assert(blockedB.step.waiting);
  assertEquals(sim.stores[store.id].putRequests.length, 2);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const getResult = get(sim, consumer, store.id);

  assert(getResult.resume);
  assert(getResult.resume[0]);
  assertEquals(getResult.step.process.data?.["foo"], "A");
  assertEquals(getResult.resume[0].process.data?.["foo"], "A");
  assertEquals(sim.stores[store.id].putRequests.length, 1);
});

Deno.test("non-blocking store with capacity > 1", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: false,
    capacity: 2,
  });
  sim.stores = registerStore(sim, store);

  const a = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const b = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });
  const c = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "C" } },
  });

  const r1 = put(sim, a, store.id, { store: store.id, foo: "A" });
  const r2 = put(sim, b, store.id, { store: store.id, foo: "B" });
  const r3 = put(sim, c, store.id, { store: store.id, foo: "C" });

  assert(!r1.step.waiting);
  assert(!r2.step.waiting);
  assert(r3.step.waiting);
  assertEquals(sim.stores[store.id].buffer.length, 2);
  assertEquals(sim.stores[store.id].putRequests.length, 1);
});

Deno.test("blocking store with unlimited capacity behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    capacity: Number.POSITIVE_INFINITY,
  });
  sim.stores = registerStore(sim, store);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const result = put(sim, producer, store.id, { store: store.id, foo: "A" });

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].putRequests.length, 1);
  assertEquals(sim.stores[store.id].buffer.length, 0);
});

Deno.test("non-blocking store with capacity 0 (requests will block)", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: false,
    capacity: 0,
  });
  sim.stores = registerStore(sim, store);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const result = put(sim, producer, store.id, { store: store.id, foo: "A" });

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].putRequests.length, 1);
  assertEquals(sim.stores[store.id].buffer.length, 0);
});

Deno.test("non-blocking store basic put/get operations", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: false,
    capacity: 1,
  });
  sim.stores = registerStore(sim, store);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const putResult = put(sim, producer, store.id, {
    store: store.id,
    foo: "A",
  });
  assert(!putResult.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const getResult = get(sim, consumer, store.id);
  assertEquals(getResult.step.process.data?.["foo"], "A");
  assertEquals(sim.stores[store.id].buffer.length, 0);
});

Deno.test("non-blocking store LIFO behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: false,
    capacity: 2,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });

  put(sim, producerA, store.id, { store: store.id, foo: "A" });
  put(sim, producerB, store.id, { store: store.id, foo: "B" });

  const consumer1 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const consumer2 = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id } },
  });

  const first = get(sim, consumer1, store.id);
  const second = get(sim, consumer2, store.id);

  assertEquals(first.step.process.data?.["foo"], "B");
  assertEquals(second.step.process.data?.["foo"], "A");
});

Deno.test("non-blocking store FIFO behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: false,
    capacity: 2,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });

  put(sim, producerA, store.id, { store: store.id, foo: "A" });
  put(sim, producerB, store.id, { store: store.id, foo: "B" });

  const consumer1 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const consumer2 = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id } },
  });

  const first = get(sim, consumer1, store.id);
  const second = get(sim, consumer2, store.id);

  assertEquals(first.step.process.data?.["foo"], "A");
  assertEquals(second.step.process.data?.["foo"], "B");
});

Deno.test("blocked gets resume in LIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });

  const waitA = get(sim, consumerA, store.id);
  const waitB = get(sim, consumerB, store.id);
  assert(waitA.step.waiting);
  assert(waitB.step.waiting);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "payload" } },
  });
  const result = put(sim, producer, store.id, {
    store: store.id,
    foo: "payload",
  });

  assert(result.resume);
  assert(result.resume[0]);
  assertEquals(result.resume[0].parent, consumerB.id);
});

Deno.test("blocked gets resume in FIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });

  const waitA = get(sim, consumerA, store.id);
  const waitB = get(sim, consumerB, store.id);
  assert(waitA.step.waiting);
  assert(waitB.step.waiting);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "payload" } },
  });
  const result = put(sim, producer, store.id, {
    store: store.id,
    foo: "payload",
  });

  assert(result.resume);
  assert(result.resume[0]);
  assertEquals(result.resume[0].parent, consumerA.id);
});

Deno.test("blocked put resumes get with preserved payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);

  const producer = createEvent({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "bar" } },
  });

  const blockedPut = put(sim, producer, store.id, {
    store: store.id,
    foo: "bar",
  });
  assertEquals(blockedPut.resume, undefined);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const resumedGet = get(sim, consumer, store.id);

  assertEquals(resumedGet.step.process.data?.["foo"], "bar");
  assert(resumedGet.resume);
});

Deno.test("buffered put returns payload on later get", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: false, capacity: 2 });
  sim.stores = registerStore(sim, store);

  const producer = createEvent({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "baz" } },
  });

  const bufferedPut = put(sim, producer, store.id, {
    store: store.id,
    foo: "baz",
  });
  assertEquals(bufferedPut.resume, undefined);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const bufferedGet = get(sim, consumer, store.id);

  assertEquals(bufferedGet.step.process.data?.["foo"], "baz");
  assertEquals(bufferedGet.resume, undefined);
});

Deno.test("store initialization defaults", () => {
  // Test default values when no options provided
  const store1 = initializeStore({});
  assertEquals(store1.blocking, true);
  assertEquals(store1.capacity, 1);
  assertEquals(store1.buffer.length, 0);
  assertEquals(store1.getRequests.length, 0);
  assertEquals(store1.putRequests.length, 0);

  // Test explicit values override defaults
  const store2 = initializeStore({
    blocking: false,
    capacity: 5,
  });
  assertEquals(store2.blocking, false);
  assertEquals(store2.capacity, 5);
});

Deno.test("error handling for non-existent store", () => {
  const sim = initializeSimulation();
  const event = createEvent({
    scheduledAt: 0,
  });

  // Should throw when trying to access non-existent store
  assertThrows(
    () => get(sim, event, "non-existent-store-id"),
    RangeError,
  );

  assertThrows(
    () => put(sim, event, "another-fake-store", { test: "data" }),
    RangeError,
  );
});

Deno.test("get throws when resumed blocked put has no payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);

  const missingPayloadPut = createEvent<FooData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none" },
  });
  sim.stores[store.id].putRequests = [missingPayloadPut];

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => get(sim, consumer, store.id),
    TypeError,
    "Store payload is missing for resumed put request",
  );
});

Deno.test("get throws when buffered item has no payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: false,
    capacity: 2,
  });
  sim.stores = registerStore(sim, store);

  const missingPayloadBuffered = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none" },
  });
  sim.stores[store.id].buffer = [missingPayloadBuffered];

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => get(sim, consumer, store.id),
    TypeError,
    "Store payload is missing for buffered item",
  );
});

Deno.test("process step unblocks multiple consumers", async () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // 3 consumers arrive first and block (no producers yet)
  const c1 = createEvent({
    scheduledAt: 0,
    process: { type: "cons", data: { store: store.id } },
  });
  const c2 = createEvent({
    scheduledAt: 1,
    process: { type: "cons", data: { store: store.id } },
  });
  const c3 = createEvent({
    scheduledAt: 2,
    process: { type: "cons", data: { store: store.id } },
  });

  // 3 producers arrive later, each unblocking one consumer in FIFO order
  const p1 = createEvent({
    scheduledAt: 10,
    process: { type: "prod", data: { store: store.id, foo: "first" } },
  });
  const p2 = createEvent({
    scheduledAt: 11,
    process: { type: "prod", data: { store: store.id, foo: "second" } },
  });
  const p3 = createEvent({
    scheduledAt: 12,
    process: { type: "prod", data: { store: store.id, foo: "third" } },
  });

  sim.timeline = scheduleEvent(sim, c1);
  sim.timeline = scheduleEvent(sim, c2);
  sim.timeline = scheduleEvent(sim, c3);
  sim.timeline = scheduleEvent(sim, p1);
  sim.timeline = scheduleEvent(sim, p2);
  sim.timeline = scheduleEvent(sim, p3);

  const { result } = await runSimulation(sim);

  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventState.Finished,
    ),
  );

  // FIFO: c1 (earliest) is unblocked by p1, c2 by p2, c3 by p3
  const c1Cont = Object.values(result.timeline.events).find(
    (e) => e.parent === c1.id && e.scheduledAt === 10,
  );
  const c2Cont = Object.values(result.timeline.events).find(
    (e) => e.parent === c2.id && e.scheduledAt === 11,
  );
  const c3Cont = Object.values(result.timeline.events).find(
    (e) => e.parent === c3.id && e.scheduledAt === 12,
  );

  assert(c1Cont);
  assert(c2Cont);
  assert(c3Cont);
  assertEquals(c1Cont.process.data?.["foo"], "first");
  assertEquals(c2Cont.process.data?.["foo"], "second");
  assertEquals(c3Cont.process.data?.["foo"], "third");
});

Deno.test("process step unblocks multiple producers", async () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // 3 producers arrive first and block (no consumers yet)
  const p1 = createEvent({
    scheduledAt: 0,
    process: { type: "prod", data: { store: store.id, foo: "first" } },
  });
  const p2 = createEvent({
    scheduledAt: 1,
    process: { type: "prod", data: { store: store.id, foo: "second" } },
  });
  const p3 = createEvent({
    scheduledAt: 2,
    process: { type: "prod", data: { store: store.id, foo: "third" } },
  });

  // 3 consumers arrive later, each unblocking one producer in FIFO order
  const c1 = createEvent({
    scheduledAt: 10,
    process: { type: "cons", data: { store: store.id } },
  });
  const c2 = createEvent({
    scheduledAt: 11,
    process: { type: "cons", data: { store: store.id } },
  });
  const c3 = createEvent({
    scheduledAt: 12,
    process: { type: "cons", data: { store: store.id } },
  });

  sim.timeline = scheduleEvent(sim, p1);
  sim.timeline = scheduleEvent(sim, p2);
  sim.timeline = scheduleEvent(sim, p3);
  sim.timeline = scheduleEvent(sim, c1);
  sim.timeline = scheduleEvent(sim, c2);
  sim.timeline = scheduleEvent(sim, c3);

  const { result } = await runSimulation(sim);

  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventState.Finished,
    ),
  );

  // Each consumer continuation carries the payload from the matching producer (FIFO)
  const c1Cont = Object.values(result.timeline.events).find(
    (e) => e.parent === c1.id && e.scheduledAt === 10,
  );
  const c2Cont = Object.values(result.timeline.events).find(
    (e) => e.parent === c2.id && e.scheduledAt === 11,
  );
  const c3Cont = Object.values(result.timeline.events).find(
    (e) => e.parent === c3.id && e.scheduledAt === 12,
  );

  assert(c1Cont);
  assert(c2Cont);
  assert(c3Cont);
  assertEquals(c1Cont.process.data?.["foo"], "first");
  assertEquals(c2Cont.process.data?.["foo"], "second");
  assertEquals(c3Cont.process.data?.["foo"], "third");
});

Deno.test("blocked puts resume in FIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });

  const blockedA = put(sim, producerA, store.id, { store: store.id, foo: "A" });
  const blockedB = put(sim, producerB, store.id, { store: store.id, foo: "B" });
  assert(blockedA.step.waiting);
  assert(blockedB.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id } },
  });
  const result = get(sim, consumer, store.id);

  // FIFO: A was enqueued first, so it is dequeued first
  assert(result.resume);
  assertEquals(result.resume[0].parent, producerA.id);
  assertEquals(result.step.process.data?.["foo"], "A");
  assertEquals(sim.stores[store.id].putRequests.length, 1);
});

Deno.test("blocked puts resume in LIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });

  const blockedA = put(sim, producerA, store.id, { store: store.id, foo: "A" });
  const blockedB = put(sim, producerB, store.id, { store: store.id, foo: "B" });
  assert(blockedA.step.waiting);
  assert(blockedB.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id } },
  });
  const result = get(sim, consumer, store.id);

  // LIFO: B was enqueued last, so it is dequeued first
  assert(result.resume);
  assertEquals(result.resume[0].parent, producerB.id);
  assertEquals(result.step.process.data?.["foo"], "B");
  assertEquals(sim.stores[store.id].putRequests.length, 1);
});

Deno.test("non-blocking store get on empty buffer blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: false, capacity: 2 });
  sim.stores = registerStore(sim, store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const result = get(sim, consumer, store.id);

  assert(result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores[store.id].getRequests.length, 1);
});

Deno.test("finished waiting placeholder is marked Finished after unblocking", async () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // Consumer blocks first, creating a waiting placeholder event
  const consumer = createEvent({
    scheduledAt: 0,
    process: { type: "cons", data: { store: store.id } },
  });
  // Producer arrives later and unblocks the consumer
  const producer = createEvent({
    scheduledAt: 5,
    process: { type: "prod", data: { store: store.id, foo: "data" } },
  });

  sim.timeline = scheduleEvent(sim, consumer);
  sim.timeline = scheduleEvent(sim, producer);

  const { result } = await runSimulation(sim);

  // The waiting placeholder (child of consumer, waiting: true) must be Finished
  const placeholder = Object.values(result.timeline.events).find(
    (e) => e.parent === consumer.id && e.waiting === true,
  );
  assert(placeholder, "waiting placeholder event must exist in timeline");
  assertEquals(result.timeline.status[placeholder.id], EventState.Finished);

  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventState.Finished,
    ),
  );
});

// ---------------------------------------------------------------------------
// getWhere
// ---------------------------------------------------------------------------

Deno.test("getWhere blocks when store is empty", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, waiter, store.id, "hasFoo");

  assert(result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1);
  assertEquals(
    sim.stores[store.id].filteredGetRequests[0].predicateType,
    "hasFoo",
  );
});

Deno.test("getWhere errors on missing store", () => {
  const sim = initializeSimulation();
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "missing" } },
  });
  assertThrows(
    () => getWhere(sim, waiter, "missing", "hasFoo"),
    RangeError,
    "Store not found",
  );
});

Deno.test("getWhere errors on unregistered predicate key", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  assertThrows(
    () => getWhere(sim, waiter, store.id, "noSuchPredicate"),
    RangeError,
    "Predicate not found in registry: noSuchPredicate",
  );
});

Deno.test("getWhere matches blocked producer in putRequests immediately", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "hello" } },
  });
  put(sim, producer, store.id, { store: store.id, foo: "hello" });
  assertEquals(sim.stores[store.id].putRequests.length, 1);

  const waiter = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, waiter, store.id, "hasFoo");

  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "hello");
  assert(result.resume);
  assertEquals(result.finish?.length, 1);
  assertEquals(sim.stores[store.id].putRequests.length, 0);
});

Deno.test("getWhere skips non-matching putRequests and blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);
  // predicate requires foo === "bar"
  sim.predicates["isBar"] = (d) => d["foo"] === "bar";

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  put(sim, producer, store.id, { store: store.id, foo: "other" });

  const waiter = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, waiter, store.id, "isBar");

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1);
  // non-matching producer still in putRequests
  assertEquals(sim.stores[store.id].putRequests.length, 1);
});

Deno.test("getWhere matches item in non-blocking buffer immediately", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: false, capacity: 3 });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "buffered" } },
  });
  put(sim, p1, store.id, { store: store.id }); // no foo — won't match
  put(sim, p2, store.id, { store: store.id, foo: "buffered" }); // matches
  assertEquals(sim.stores[store.id].buffer.length, 2);

  const waiter = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, waiter, store.id, "hasFoo");

  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "buffered");
  assertEquals(result.resume, undefined);
  // the matching item was consumed, only the non-matching one remains
  assertEquals(sim.stores[store.id].buffer.length, 1);
});

Deno.test("getWhere skips non-matching buffer items and blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: false, capacity: 2 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (d) => d["foo"] === "bar";

  const p = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  put(sim, p, store.id, { store: store.id, foo: "other" });

  const waiter = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, waiter, store.id, "isBar");

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1);
  assertEquals(sim.stores[store.id].buffer.length, 1); // item still buffered
});

Deno.test("put resolves a matching filteredGetRequests waiter", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, waiter, store.id, "hasFoo");
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "match" } },
  });
  const result = put(sim, producer, store.id, {
    store: store.id,
    foo: "match",
  });

  assert(result.resume);
  assertEquals(result.resume[0].process.data?.["foo"], "match");
  assertEquals(result.finish?.length, 1);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 0);
});

Deno.test("put buffers when filteredGetRequests waiter predicate does not match", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: false, capacity: 3 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (d) => d["foo"] === "bar";

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, waiter, store.id, "isBar");

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  const result = put(sim, producer, store.id, {
    store: store.id,
    foo: "other",
  });

  // non-matching put still goes to buffer (non-blocking store with capacity)
  assert(!result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores[store.id].buffer.length, 1);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1); // waiter still waiting
});

Deno.test("put with unregistered predicate key in filteredGetRequests throws", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ blocking: true });
  sim.stores = registerStore(sim, store);
  // register predicate to call getWhere, then remove it to simulate corruption
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, waiter, store.id, "hasFoo");
  delete sim.predicates["hasFoo"]; // simulate missing predicate

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });
  assertThrows(
    () => put(sim, producer, store.id, { store: store.id, foo: "x" }),
    RangeError,
    "Predicate not found in registry: hasFoo",
  );
});

Deno.test("getWhere FIFO: first matching waiter is served first by put", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const w1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const w2 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, w1, store.id, "hasFoo");
  getWhere(sim, w2, store.id, "hasFoo");
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 2);

  const producer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });
  const result = put(sim, producer, store.id, { store: store.id, foo: "x" });

  // FIFO: w1 (index 0) is served
  assert(result.resume);
  assertEquals(result.resume[0].parent, w1.id);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1);
});

Deno.test("getWhere LIFO: last matching waiter is served first by put", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    blocking: true,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (d) => typeof d["foo"] === "string";

  const w1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const w2 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, w1, store.id, "hasFoo");
  getWhere(sim, w2, store.id, "hasFoo");

  const producer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });
  const result = put(sim, producer, store.id, { store: store.id, foo: "x" });

  // LIFO: w2 (index 1, last in) is served
  assert(result.resume);
  assertEquals(result.resume[0].parent, w2.id);
  assertEquals(sim.stores[store.id].filteredGetRequests.length, 1);
});

Deno.test("getWhere integration: full round-trip through runSimulation", async () => {
  interface TaskData extends StateData {
    taskId: number;
    urgent: boolean;
  }

  const TASK_STORE = "tasks" as const;

  const sim = initializeSimulation();
  sim.predicates["isUrgent"] = (d) => d["urgent"] === true;

  const store = initializeStore({
    id: TASK_STORE,
    blocking: false,
    capacity: 10,
  });
  sim.stores = registerStore(sim, store);

  // Scheduler process: waits for an urgent task using getWhere
  const scheduler: ProcessDefinition<{
    wait: TaskData;
    run: TaskData;
  }> = {
    type: "scheduler",
    initial: "wait",
    steps: {
      wait(sim, event, state) {
        const { step, resume, finish } = getWhere(
          sim,
          event,
          TASK_STORE,
          "isUrgent",
        );
        return {
          state: { ...state, step: "run" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      run(_sim, _event, state) {
        return { state, next: [] };
      },
    },
  };

  sim.processes = registerProcess(sim, scheduler);

  // Producer process: buffers a non-urgent task then an urgent task.
  // The non-urgent put seeds the non-blocking buffer directly (result discarded, like er-triage
  // seed events); the urgent put resolves the scheduler's filteredGetRequests waiter.
  // A `done` step is required so that updatedPut (inheritStep: true) does not re-enter `go`.
  const producer: ProcessDefinition<{ go: TaskData; done: TaskData }> = {
    type: "producer",
    initial: "go",
    steps: {
      go(sim, event, state) {
        // Seed the non-blocking buffer; continuation event discarded intentionally.
        put(sim, event, TASK_STORE, { taskId: 1, urgent: false });
        // Urgent task: resolves the scheduler's getWhere waiter immediately.
        const { step, resume, finish } = put(sim, event, TASK_STORE, {
          taskId: 2,
          urgent: true,
        });
        return {
          state: { ...state, step: "done" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      done(_sim, _event, state) {
        return { state, next: [] };
      },
    },
  };

  sim.processes = registerProcess(sim, producer);

  // Scheduler starts first (t=0), will block on getWhere
  const schedEvent = createEvent({
    scheduledAt: 0,
    process: { type: "scheduler", data: { taskId: 0, urgent: false } },
  });
  // Producer fires at t=1, puts both tasks
  const prodEvent = createEvent({
    scheduledAt: 1,
    process: { type: "producer", data: { taskId: 0, urgent: false } },
  });

  sim.timeline = scheduleEvent(sim, schedEvent);
  sim.timeline = scheduleEvent(sim, prodEvent);

  const { result } = await runSimulation(sim);

  // Scheduler must have completed with the urgent task (taskId=2)
  const schedulerState = Object.values(result.state).find(
    (s) => s.type === "scheduler" && s.data["taskId"] === 2,
  );
  assert(schedulerState, "scheduler must have processed the urgent task");
  assertEquals(schedulerState.step, "run");

  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventState.Finished,
    ),
  );
});

// ── registerDiscipline ────────────────────────────────────────────────────────

Deno.test("registerDiscipline: custom EDF comparator controls get order", () => {
  interface EdfData extends StateData {
    deadline: number;
  }

  const sim = initializeSimulation();
  sim.disciplines = registerDiscipline(sim, {
    type: "edf" as const,
    comparator: (a, b) =>
      (a.event.process.data as EdfData).deadline -
      (b.event.process.data as EdfData).deadline,
  });

  const store = initializeStore({
    id: "edf-store",
    blocking: false,
    capacity: 3,
    discipline: "edf",
  });
  sim.stores = registerStore(sim, store);

  const src = createEvent<EdfData>({
    scheduledAt: 0,
    process: { type: "none", data: { deadline: 0 } },
  });
  put(sim, src, "edf-store", { deadline: 30 });
  put(sim, src, "edf-store", { deadline: 10 });
  put(sim, src, "edf-store", { deadline: 20 });

  const consumer = createEvent<EdfData>({
    scheduledAt: 0,
    process: { type: "none" },
  });
  const r1 = get(sim, consumer, "edf-store");
  const r2 = get(sim, consumer, "edf-store");
  const r3 = get(sim, consumer, "edf-store");

  assertEquals(r1.step.process.data?.["deadline"], 10);
  assertEquals(r2.step.process.data?.["deadline"], 20);
  assertEquals(r3.step.process.data?.["deadline"], 30);
});

// ── hasStorePayload guard in `get` ────────────────────────────────────────────
// `get` uses selectFromQueue without a predicate, so events with undefined data
// are selectable. Both the putRequests and buffer paths must throw TypeError.

Deno.test("get throws TypeError when putRequest has no payload", () => {
  const sim = initializeSimulation();
  const noDataEvent = createEvent({
    scheduledAt: 0,
    process: { type: "none" },
  });

  sim.stores = {
    "s": {
      id: "s",
      capacity: 1,
      blocking: true,
      discipline: QueueDiscipline.LIFO,
      buffer: [],
      getRequests: [],
      putRequests: [noDataEvent],
      filteredGetRequests: [],
    },
  };

  const consumer = createEvent({ scheduledAt: 0, process: { type: "none" } });
  assertThrows(
    () => get(sim, consumer, "s"),
    TypeError,
    "Store payload is missing for resumed put request",
  );
});

Deno.test("get throws TypeError when buffered item has no payload", () => {
  const sim = initializeSimulation();
  const noDataEvent = createEvent({
    scheduledAt: 0,
    process: { type: "none" },
  });

  sim.stores = {
    "s": {
      id: "s",
      capacity: 1,
      blocking: false,
      discipline: QueueDiscipline.LIFO,
      buffer: [noDataEvent],
      getRequests: [],
      putRequests: [],
      filteredGetRequests: [],
    },
  };

  const consumer = createEvent({ scheduledAt: 0, process: { type: "none" } });
  assertThrows(
    () => get(sim, consumer, "s"),
    TypeError,
    "Store payload is missing for buffered item",
  );
});
