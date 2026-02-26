import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createEvent,
  EventState,
  get,
  initializeSimulation,
  initializeStore,
  ProcessDefinition,
  put,
  QueueDiscipline,
  registerProcess,
  registerStore,
  runSimulation,
  scheduleEvent,
  StateData,
  StoreID,
} from "../mod.ts";

interface FooData extends StateData {
  foo?: string;
  store: StoreID;
}

const prod: ProcessDefinition<{
  start: [FooData, [FooData, FooData] | [FooData]];
  stop: [FooData, []];
}> = {
  type: "prod",
  initial: "start",
  steps: {
    start(sim, event, state) {
      const { step, resume } = put(sim, event, state.data["store"], {
        ...state.data,
      });

      return {
        state: { ...state, step: "stop" },
        next: resume ? [step, resume] : [step],
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
  start: [FooData, [FooData, FooData] | [FooData]];
  stop: [FooData, []];
}> = {
  type: "cons",
  initial: "start",
  steps: {
    start(sim, event, state) {
      const { step, resume } = get(sim, event, state.data["store"]);

      return {
        state: {
          ...state,
          data: { ...step.process.data ?? state.data },
          step: "stop",
        },
        next: resume ? [step, resume] : [step],
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

  const store = initializeStore<FooData>({
    blocking: true,
  });

  sim.stores = registerStore(sim, store);

  sim.registry = registerProcess(sim, prod);
  sim.registry = registerProcess(sim, cons);

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

  const [stop, _stats] = await runSimulation(sim);

  // Producer has been unblocked by consumer
  const prodBlocked = Object.values(stop.timeline.events).find((event) =>
    event.id === e1.id
  );
  const prodBlockedFinished = [...stop.timeline.transitions].reverse().find((
    transition,
  ) =>
    transition.id === prodBlocked?.id &&
    transition.state === EventState.Finished
  );
  assertEquals(prodBlockedFinished?.at, 0);
  const prodUnblocked = Object.values(stop.timeline.events).find((event) =>
    event.parent && event.parent === e1.id && event.scheduledAt === 5
  );
  const prodUnblockedFinished = [...stop.timeline.transitions].reverse().find((
    transition,
  ) =>
    transition.id === prodUnblocked?.id &&
    transition.state === EventState.Finished
  );
  assertEquals(prodUnblockedFinished?.at, 5);

  // Consumer has been unblocked by producer and has gotten the data
  const consBlocked = Object.values(stop.timeline.events).find((event) =>
    event.id === e3.id
  );
  const consBlockedFinished = [...stop.timeline.transitions].reverse().find((
    transition,
  ) =>
    transition.id === consBlocked?.id &&
    transition.state === EventState.Finished
  );
  assertEquals(consBlockedFinished?.at, 10);
  const consUnblocked = Object.values(stop.timeline.events).find((event) =>
    event.parent && event.parent === e3.id && event.scheduledAt === 15
  );
  const consUnblockedFinished = [...stop.timeline.transitions].reverse().find((
    transition,
  ) =>
    transition.id === consUnblocked?.id &&
    transition.state === EventState.Finished
  );
  assertEquals(consUnblockedFinished?.at, 15);
  assertEquals(consUnblocked!.process.data!["foo"], "baz");

  // All processes have reached their final step
  assert(Object.values(stop.state).every((state) => state.step === "stop"));
});

Deno.test("multiple consumers with single producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({
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
  assertEquals(putResult.resume.parent, consumerA.id);
  assertEquals(sim.stores[store.id].getRequests.length, 1);
});

Deno.test("multiple producers with delayed consumers", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({
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
  assertEquals(getResult.step.process.data?.["foo"], "A");
  assertEquals(getResult.resume.process.data?.["foo"], "A");
  assertEquals(sim.stores[store.id].putRequests.length, 1);
});

Deno.test("non-blocking store with capacity > 1", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({
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
  const store = initializeStore<FooData>({
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

Deno.test("non-blocking store with capacity 0 (immediate rejection)", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({
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
  const store = initializeStore<FooData>({
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
  const store = initializeStore<FooData>({
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
  const store = initializeStore<FooData>({
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
  const store = initializeStore<FooData>({
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
  assertEquals(result.resume.parent, consumerB.id);
});

Deno.test("blocked gets resume in FIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({
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
  assertEquals(result.resume.parent, consumerA.id);
});

Deno.test("blocked put resumes get with preserved payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({ blocking: true });
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
  const store = initializeStore<FooData>({ blocking: false, capacity: 2 });
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
  const store = initializeStore<FooData>({ blocking: true });
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
  const store = initializeStore<FooData>({
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

Deno.test("unsupported queue discipline throws", () => {
  const sim = initializeSimulation();
  const store = initializeStore<FooData>({
    blocking: true,
    discipline: "BROKEN" as QueueDiscipline,
  });
  sim.stores = registerStore(sim, store);

  const waiter = createEvent<FooData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none", data: { store: store.id } },
  });
  sim.stores[store.id].getRequests = [waiter];

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });

  assertThrows(
    () => put(sim, producer, store.id, { store: store.id, foo: "x" }),
    Error,
    "Unsupported queue discipline",
  );
});
