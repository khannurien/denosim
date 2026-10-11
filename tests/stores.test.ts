import { assert, assertEquals, assertThrows } from "@std/assert";

import type {
  ProcessDefinition,
  ProcessHandler,
  StateData,
  StoreID,
} from "../src/model.ts";
import { EventStatus, QueueDiscipline } from "../src/model.ts";
import {
  cancel,
  get,
  getWhere,
  initializeStore,
  put,
  registerStore,
} from "../src/stores.ts";
import { runSimulation } from "../src/runner.ts";
import {
  continueEvent,
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
}, Record<StoreID, FooData>> = {
  type: "cons",
  initial: "start",
  steps: {
    start(sim, event, state) {
      const { step, item, resume, finish } = get(
        sim,
        event,
        state.data["store"],
      );

      return {
        state: {
          ...state,
          data: { ...item ?? state.data },
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

Deno.test("producer-consumer synchronization with a synchronous store", async () => {
  const sim = initializeSimulation();

  const store = initializeStore({});

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
    transition.status === EventStatus.Finished
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
      transition.status === EventStatus.Finished,
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
    transition.status === EventStatus.Finished
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
      transition.status === EventStatus.Finished,
  );
  assertEquals(consUnblockedFinished?.at, 15);
  assertEquals(consUnblocked!.process.data!["foo"], "baz");

  // All processes have reached their final step
  assert(Object.values(result.states).every((state) => state.step === "stop"));
});

Deno.test("processes keep their identifier across a blocked store operation", async () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);

  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // Consumer blocks first, producer resumes it later
  const e1 = createEvent({
    scheduledAt: 0,
    process: { type: "cons", data: { store: store.id } },
  });
  const e2 = createEvent({
    scheduledAt: 5,
    process: { type: "prod", data: { store: store.id, foo: "bar" } },
  });

  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);

  const { result } = await runSimulation(sim);
  const states = Object.values(result.states);

  const consStates = states.filter((state) => state.type === "cons");
  const prodStates = states.filter((state) => state.type === "prod");

  // Each process handled two events (`start` then `stop`) under a single identifier
  assertEquals(consStates.length, 2);
  assertEquals(prodStates.length, 2);
  assert(consStates.every((state) => state.id === e1.id));
  assert(prodStates.every((state) => state.id === e2.id));
});

Deno.test("multiple consumers with single producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
  assertEquals(sim.stores[store.id].getRequests.entries.length, 2);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });
  const putResult = put(sim, producer, store.id, { store: store.id, foo: "x" });

  assert(putResult.resume);
  assert(putResult.resume[0]);
  assertEquals(putResult.resume[0].parent, consumerA.id);
  assertEquals(sim.stores[store.id].getRequests.entries.length, 1);
});

Deno.test("multiple producers with delayed consumers", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
  assertEquals(sim.stores[store.id].putRequests.entries.length, 2);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const getResult = get(sim, consumer, store.id);

  assert(getResult.resume);
  assert(getResult.resume[0]);
  assertEquals(getResult.step.process.data?.["foo"], "A");
  // Producer A is resumed, and its continuation does not carry the item back
  assertEquals(getResult.finish, [blockedA.step]);
  assertEquals(getResult.resume[0].process.data, undefined);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
});

Deno.test("buffered store with capacity > 1", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
  assertEquals(sim.stores[store.id].buffer.entries.length, 2);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
});

Deno.test("store with capacity 0 (requests will block)", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 0,
  });
  sim.stores = registerStore(sim, store);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const result = put(sim, producer, store.id, { store: store.id, foo: "A" });

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
  assertEquals(sim.stores[store.id].buffer.entries.length, 0);
});

Deno.test("buffered store basic put/get operations", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
  assertEquals(sim.stores[store.id].buffer.entries.length, 0);
});

Deno.test("buffered store LIFO behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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

Deno.test("buffered store FIFO behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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

Deno.test("buffered store at capacity serves buffer before blocked producers", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 1,
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
  const blocked = put(sim, producerB, store.id, { store: store.id, foo: "B" });

  assert(blocked.step.waiting);

  const consumer1 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const consumer2 = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id } },
  });

  const first = get(sim, consumer1, store.id);

  // Buffered item is delivered; blocked producer takes the freed slot and resumes
  assertEquals(first.item?.["foo"], "A");
  assertEquals(first.step.process.data?.["foo"], "A");
  assertEquals(first.resume?.length, 1);
  assertEquals(first.finish, [blocked.step]);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 0);
  assertEquals(sim.stores[store.id].buffer.entries.length, 1);

  const second = get(sim, consumer2, store.id);

  assertEquals(second.step.process.data?.["foo"], "B");
  assertEquals(sim.stores[store.id].buffer.entries.length, 0);
});

Deno.test("buffered LIFO store at capacity applies discipline per queue", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 1,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, store);

  for (const foo of ["A", "B", "C"]) {
    const producer = createEvent<FooData>({
      scheduledAt: 0,
      process: { type: "none", data: { store: store.id, foo } },
    });
    put(sim, producer, store.id, { store: store.id, foo });
  }

  assertEquals(sim.stores[store.id].buffer.entries.length, 1);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 2);

  const received = Array.from({ length: 3 }, () => {
    const consumer = createEvent<FooData>({
      scheduledAt: 1,
      process: { type: "none", data: { store: store.id } },
    });
    return get(sim, consumer, store.id).step.process.data?.["foo"];
  });

  // A is the only buffered item; blocked producers then take the freed slot in LIFO order
  assertEquals(received, ["A", "C", "B"]);
  assertEquals(sim.stores[store.id].buffer.entries.length, 0);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 0);
});

Deno.test("blocked gets resume in LIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
  const store = initializeStore({});
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
  const store = initializeStore({ capacity: 2 });
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
  assertEquals(store1.capacity, 0);
  assertEquals(store1.buffer.entries.length, 0);
  assertEquals(store1.getRequests.entries.length, 0);
  assertEquals(store1.putRequests.entries.length, 0);

  // Test explicit values override defaults
  const store2 = initializeStore({
    capacity: 5,
  });
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
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);

  const missingPayloadPut = createEvent<FooData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none" },
  });
  sim.stores[store.id].putRequests = {
    entries: [{ event: missingPayloadPut, seq: 0 }],
    seq: 1,
  };

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => get(sim, consumer, store.id),
    TypeError,
    "Store payload is missing for event:",
  );
});

Deno.test("get throws when buffered item has no payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 2,
  });
  sim.stores = registerStore(sim, store);

  const missingPayloadBuffered = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none" },
  });
  sim.stores[store.id].buffer = {
    entries: [{ event: missingPayloadBuffered, seq: 0 }],
    seq: 1,
  };

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => get(sim, consumer, store.id),
    TypeError,
    "Store payload is missing for event:",
  );
});

Deno.test("process step unblocks multiple consumers", async () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
      (e) => result.timeline.status[e.id] === EventStatus.Finished,
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
      (e) => result.timeline.status[e.id] === EventStatus.Finished,
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
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
});

Deno.test("blocked puts resume in LIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
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
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
});

Deno.test("buffered store get on empty buffer blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 2 });
  sim.stores = registerStore(sim, store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const result = get(sim, consumer, store.id);

  assert(result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores[store.id].getRequests.entries.length, 1);
});

Deno.test("request is marked Finished after unblocking", async () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // Consumer blocks first, creating a request
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

  // The request (child of consumer, waiting: true) must be Finished
  const request = Object.values(result.timeline.events).find(
    (e) => e.parent === consumer.id && e.waiting === true,
  );
  assert(request, "request must exist in timeline");
  assertEquals(result.timeline.status[request.id], EventStatus.Finished);

  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventStatus.Finished,
    ),
  );
});

// ---------------------------------------------------------------------------
// getWhere
// ---------------------------------------------------------------------------

Deno.test("getWhere blocks when store is empty", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "hasFoo");

  assert(result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);
  assertEquals(
    sim.stores[store.id].getWhereRequests[0].predicateType,
    "hasFoo",
  );
});

Deno.test("getWhere errors on missing store", () => {
  const sim = initializeSimulation();
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "missing" } },
  });
  assertThrows(
    () => getWhere(sim, consumer, "missing", "hasFoo"),
    RangeError,
    "Store not found",
  );
});

Deno.test("getWhere errors on unregistered predicate key", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  assertThrows(
    () => getWhere(sim, consumer, store.id, "noSuchPredicate"),
    RangeError,
    "Predicate not found in registry: noSuchPredicate",
  );
});

Deno.test("getWhere matches blocked producer in putRequests immediately", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "hello" } },
  });
  put(sim, producer, store.id, { store: store.id, foo: "hello" });
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "hasFoo");

  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "hello");
  assert(result.resume);
  assertEquals(result.finish?.length, 1);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 0);
});

Deno.test("getWhere skips non-matching putRequests and blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);
  // predicate requires foo === "bar"
  sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  put(sim, producer, store.id, { store: store.id, foo: "other" });

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "isBar");

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);
  // non-matching producer still in putRequests
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
});

Deno.test("getWhere matches item in buffer immediately", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 3 });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "buffered" } },
  });
  put(sim, p1, store.id, { store: store.id }); // no foo: won't match
  put(sim, p2, store.id, { store: store.id, foo: "buffered" }); // matches
  assertEquals(sim.stores[store.id].buffer.entries.length, 2);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "hasFoo");

  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "buffered");
  assertEquals(result.resume, undefined);
  // the matching item was consumed, only the non-matching one remains
  assertEquals(sim.stores[store.id].buffer.entries.length, 1);
});

Deno.test("getWhere skips non-matching buffer items and blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 2 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

  const p = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  put(sim, p, store.id, { store: store.id, foo: "other" });

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "isBar");

  assert(result.step.waiting);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);
  assertEquals(sim.stores[store.id].buffer.entries.length, 1); // item still buffered
});

Deno.test("getWhere on a full buffer: matching buffered item frees a slot for a blocked producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "bar" } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  put(sim, p1, store.id, { store: store.id, foo: "bar" }); // buffered
  const blocked = put(sim, p2, store.id, { store: store.id, foo: "other" }); // blocks
  assert(blocked.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "isBar");

  assertEquals(result.step.process.data?.["foo"], "bar");
  assertEquals(result.resume?.length, 1);
  assertEquals(result.finish, [blocked.step]);
  // the blocked producer's item took the freed slot, whether or not it matches
  assertEquals(sim.stores[store.id].putRequests.entries.length, 0);
  assertEquals(
    sim.stores[store.id].buffer.entries[0].event.process.data?.["foo"],
    "other",
  );
});

Deno.test("getWhere on a full buffer: falls back to a matching blocked producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "bar" } },
  });
  put(sim, p1, store.id, { store: store.id, foo: "other" }); // buffered
  const blocked = put(sim, p2, store.id, { store: store.id, foo: "bar" }); // blocks
  assert(blocked.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "isBar");

  // direct handoff from the blocked producer: its item never enters the buffer
  assertEquals(result.step.process.data?.["foo"], "bar");
  assertEquals(result.resume?.length, 1);
  assertEquals(result.finish, [blocked.step]);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 0);
  assertEquals(
    sim.stores[store.id].buffer.entries[0].event.process.data?.["foo"],
    "other",
  );
});

Deno.test("put resolves a matching getWhere request", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, consumer, store.id, "hasFoo");
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);

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
  assertEquals(sim.stores[store.id].getWhereRequests.length, 0);
});

Deno.test("put buffers when the getWhere request's predicate does not match", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 3 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, consumer, store.id, "isBar");

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "other" } },
  });
  const result = put(sim, producer, store.id, {
    store: store.id,
    foo: "other",
  });

  // non-matching put still goes to buffer (buffered store with capacity)
  assert(!result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores[store.id].buffer.entries.length, 1);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1); // request still queued
});

Deno.test("put with unregistered predicate key in getWhereRequests throws", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);
  // register predicate to call getWhere, then remove it to simulate corruption
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  getWhere(sim, consumer, store.id, "hasFoo");
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

Deno.test("getWhere FIFO: first matching request is served first by put", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

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
  assertEquals(sim.stores[store.id].getWhereRequests.length, 2);

  const producer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id, foo: "x" } },
  });
  const result = put(sim, producer, store.id, { store: store.id, foo: "x" });

  // FIFO: w1 (index 0) is served
  assert(result.resume);
  assertEquals(result.resume[0].parent, w1.id);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);
});

Deno.test("getWhere LIFO: last matching request is served first by put", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.predicates["hasFoo"] = (event) =>
    typeof event.process?.data?.["foo"] === "string";

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
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);
});

Deno.test("getWhere integration: full round-trip through runSimulation", async () => {
  interface TaskData extends StateData {
    taskId: number;
    urgent: boolean;
  }

  const TASK_STORE = "tasks" as const;

  const sim = initializeSimulation();
  sim.predicates["isUrgent"] = (event) =>
    event.process?.data?.["urgent"] === true;

  const store = initializeStore({
    id: TASK_STORE,
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
  // The non-urgent put seeds the buffer directly (result discarded, like er-triage
  // seed events); the urgent put resolves the scheduler's getWhere request.
  // A `done` step is required so that updatedPut (continues: true) does not re-enter `go`.
  const producer: ProcessDefinition<{ go: TaskData; done: TaskData }> = {
    type: "producer",
    initial: "go",
    steps: {
      go(sim, event, state) {
        // Seed the buffer; continuation event discarded intentionally.
        put(sim, event, TASK_STORE, { taskId: 1, urgent: false });
        // Urgent task: resolves the scheduler's getWhere request immediately.
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
  const schedulerState = Object.values(result.states).find(
    (s) => s.type === "scheduler" && s.data["taskId"] === 2,
  );
  assert(schedulerState, "scheduler must have processed the urgent task");
  assertEquals(schedulerState.step, "run");

  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventStatus.Finished,
    ),
  );
});

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
      capacity: 0,
      discipline: QueueDiscipline.LIFO,
      buffer: { entries: [], seq: 0 },
      getRequests: { entries: [], seq: 0 },
      putRequests: { entries: [{ event: noDataEvent, seq: 0 }], seq: 1 },
      getWhereRequests: [],
    },
  };

  const consumer = createEvent({ scheduledAt: 0, process: { type: "none" } });
  assertThrows(
    () => get(sim, consumer, "s"),
    TypeError,
    "Store payload is missing for event:",
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
      discipline: QueueDiscipline.LIFO,
      buffer: { entries: [{ event: noDataEvent, seq: 0 }], seq: 1 },
      getRequests: { entries: [], seq: 0 },
      putRequests: { entries: [], seq: 0 },
      getWhereRequests: [],
    },
  };

  const consumer = createEvent({ scheduledAt: 0, process: { type: "none" } });
  assertThrows(
    () => get(sim, consumer, "s"),
    TypeError,
    "Store payload is missing for event:",
  );
});

Deno.test("put throws when discipline is not registered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ discipline: "unregistered" });
  sim.stores = registerStore(sim, store);

  const event = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => put(sim, event, store.id, { store: store.id }),
    RangeError,
    "Discipline definition not found in registry: unregistered",
  );
});

Deno.test("get throws when discipline is not registered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ discipline: "unregistered" });
  sim.stores = registerStore(sim, store);

  const event = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => get(sim, event, store.id),
    RangeError,
    "Discipline definition not found in registry: unregistered",
  );
});

Deno.test("getWhere throws when discipline is not registered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ discipline: "unregistered" });
  sim.stores = registerStore(sim, store);
  sim.predicates["any"] = () => true;

  const event = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });

  assertThrows(
    () => getWhere(sim, event, store.id, "any"),
    RangeError,
    "Discipline definition not found in registry: unregistered",
  );
});

Deno.test("put with custom discipline serves getWhereRequests in custom sort order", () => {
  // Exercises the sort() branch (non-FIFO/LIFO discipline) in the getWhereRequests scan.
  interface DeadlineData extends StateData {
    deadline: number;
    store: StoreID;
  }

  const sim = initializeSimulation();
  sim.disciplines = registerDiscipline(sim, {
    type: "edf-fgr" as const,
    comparator: (a, b) =>
      ((a.event.process.data as DeadlineData).deadline) -
      ((b.event.process.data as DeadlineData).deadline),
  });

  const store = initializeStore({ discipline: "edf-fgr" });
  sim.stores = registerStore(sim, store);
  sim.predicates["anyDeadline"] = () => true;

  // Two getWhere requests with different deadlines; EDF should serve tighter first.
  const requestA = createEvent<DeadlineData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none", data: { store: store.id, deadline: 20 } },
  });
  const requestB = createEvent<DeadlineData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none", data: { store: store.id, deadline: 10 } },
  });

  sim.stores[store.id].getWhereRequests = [
    { event: requestA, predicateType: "anyDeadline", seq: 0 },
    { event: requestB, predicateType: "anyDeadline", seq: 1 },
  ];

  const producer = createEvent<DeadlineData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, deadline: 0 } },
  });
  const result = put(sim, producer, store.id, { store: store.id, deadline: 0 });

  // requestB (deadline 10) must be served first.
  assert(result.resume);
  assertEquals(result.finish?.[0].id, requestB.id);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);
  assertEquals(
    sim.stores[store.id].getWhereRequests[0].event.id,
    requestA.id,
  );
});

Deno.test("multi-store simulation: two stores interact in a single run", async () => {
  // Pipeline: producer → storeA → relay → storeB → consumer
  // The relay process gets from storeA, then puts to storeB.
  // Verifies that independent stores in the same simulation coordinate correctly.
  const sim = initializeSimulation();

  const storeA = initializeStore({ capacity: 1 });
  const storeB = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, storeA);
  sim.stores = registerStore(sim, storeB);

  interface PipeData extends StateData {
    storeA: StoreID;
    storeB: StoreID;
    value?: number;
  }

  const producer: ProcessDefinition<{ start: PipeData; done: PipeData }> = {
    type: "producer",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const { step, resume, finish } = put(
          sim,
          event,
          state.data["storeA"],
          { ...state.data, value: 42 },
        );
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

  const relay: ProcessDefinition<
    { take: PipeData; give: PipeData; done: PipeData },
    Record<StoreID, PipeData>
  > = {
    type: "relay",
    initial: "take",
    steps: {
      take(sim, event, state) {
        const { step, item, resume, finish } = get(
          sim,
          event,
          state.data["storeA"],
        );
        return {
          state: {
            ...state,
            data: { ...item ?? state.data },
            step: "give",
          },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      give(sim, event, state) {
        const { step, resume, finish } = put(
          sim,
          event,
          state.data["storeB"],
          state.data,
        );
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

  const consumer: ProcessDefinition<
    { start: PipeData; done: PipeData },
    Record<StoreID, PipeData>
  > = {
    type: "consumer",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const { step, item, resume, finish } = get(
          sim,
          event,
          state.data["storeB"],
        );
        return {
          state: {
            ...state,
            data: { ...item ?? state.data },
            step: "done",
          },
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
  sim.processes = registerProcess(sim, relay);
  sim.processes = registerProcess(sim, consumer);

  const data: PipeData = { storeA: storeA.id, storeB: storeB.id };

  const prodEvent = createEvent<PipeData>({
    scheduledAt: 0,
    process: { type: "producer", data },
  });
  const relayEvent = createEvent<PipeData>({
    scheduledAt: 1,
    process: { type: "relay", data },
  });
  const consEvent = createEvent<PipeData>({
    scheduledAt: 2,
    process: { type: "consumer", data },
  });

  sim.timeline = scheduleEvent(sim, prodEvent);
  sim.timeline = scheduleEvent(sim, relayEvent);
  sim.timeline = scheduleEvent(sim, consEvent);

  const { result } = await runSimulation(sim);

  // All events finish successfully.
  assert(
    Object.values(result.timeline.events).every(
      (e) => result.timeline.status[e.id] === EventStatus.Finished,
    ),
  );

  // The consumer received the value that the producer originally put into storeA.
  const consStatus = [...result.timeline.transitions]
    .reverse()
    .find((t) => t.id === consEvent.id && t.status === EventStatus.Finished);
  assert(consStatus);

  // storeA and storeB are both drained (no buffered items remain).
  assertEquals(result.stores[storeA.id].buffer.entries.length, 0);
  assertEquals(result.stores[storeB.id].buffer.entries.length, 0);
});

Deno.test("getWhere skips non-matching putRequests and returns the first match", () => {
  // Exercises the re-insertion loop in storeQueuePopWhere: when the discipline-best
  // entry does not satisfy the predicate it is set aside; after a matching entry is
  // found the rejected entries are re-inserted back into the heap.
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, store);
  sim.predicates["isMatch"] = (event) =>
    event.process?.data?.["foo"] === "match";

  const prodA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "skip" } },
  });
  const prodB = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "match" } },
  });

  put(sim, prodA, store.id, { store: store.id, foo: "skip" });
  put(sim, prodB, store.id, { store: store.id, foo: "match" });

  const consumer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: store.id } },
  });
  const result = getWhere(sim, consumer, store.id, "isMatch");

  // prodB matched; prodA was rejected and re-inserted.
  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "match");
  assert(result.resume);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);
  assertEquals(
    sim.stores[store.id].putRequests.entries[0].event.process.data?.["foo"],
    "skip",
  );
});

Deno.test("a producer's next step sees its returned state, not the item it put", async () => {
  interface CountData extends StateData {
    n: number;
  }

  // Runs a producer putting `{ n: 1 }` while returning a state where `n` is 2
  // Returns the `n` seen by its next step, once per run of that step
  async function seenAfterPut(capacity: number, consumerAt: number) {
    const sim = initializeSimulation();
    const store = initializeStore({ capacity });
    sim.stores = registerStore(sim, store);
    const seen: number[] = [];

    const producer: ProcessDefinition<{
      start: CountData;
      stop: CountData;
    }> = {
      type: "producer",
      initial: "start",
      steps: {
        start(sim, event, state) {
          const { step, resume, finish } = put(sim, event, store.id, { n: 1 });

          return {
            state: { ...state, step: "stop", data: { n: 2 } },
            next: resume ? [step, ...resume] : [step],
            finish: finish ?? [],
          };
        },
        stop(_sim, _event, state) {
          seen.push(state.data.n);
          return { state, next: [] };
        },
      },
    };

    const consumer: ProcessDefinition<{
      start: CountData;
    }> = {
      type: "consumer",
      initial: "start",
      steps: {
        start(sim, event, state) {
          const { step, resume, finish } = get(sim, event, store.id);

          return {
            state,
            next: step.waiting ? [step] : resume ?? [],
            finish: finish ?? [],
          };
        },
      },
    };

    sim.processes = registerProcess(sim, producer);
    sim.processes = registerProcess(sim, consumer);

    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: consumerAt, process: { type: "consumer" } }),
    );
    sim.timeline = scheduleEvent(
      sim,
      createEvent({
        scheduledAt: 2,
        process: { type: "producer", data: { n: 0 } },
      }),
    );

    await runSimulation(sim);

    return seen;
  }

  // Consumer already waiting: direct handoff
  assertEquals(await seenAfterPut(1, 0), [2]);
  // Buffered store: the item is held in the buffer
  assertEquals(await seenAfterPut(1, 5), [2]);
  // Synchronous store: the producer blocks until the consumer arrives
  assertEquals(await seenAfterPut(0, 5), [2]);
});

Deno.test("put serves filtered and unconditional consumers in discipline order", () => {
  // Returns which of the two waiting consumers is handed a matching item
  function served(discipline: QueueDiscipline, filteredFirst: boolean) {
    const sim = initializeSimulation();
    const store = initializeStore({ capacity: 1, discipline });
    sim.stores = registerStore(sim, store);
    sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

    const consumer = () =>
      createEvent<FooData>({
        scheduledAt: 0,
        process: { type: "none", data: { store: store.id } },
      });

    const waiting: Record<string, string> = {};
    for (const filtered of [filteredFirst, !filteredFirst]) {
      const { step } = filtered
        ? getWhere(sim, consumer(), store.id, "isBar")
        : get(sim, consumer(), store.id);
      waiting[step.id] = filtered ? "filtered" : "unconditional";
    }

    const producer = createEvent<FooData>({
      scheduledAt: 1,
      process: { type: "none", data: { store: store.id, foo: "bar" } },
    });
    const result = put(sim, producer, store.id, {
      store: store.id,
      foo: "bar",
    });

    return waiting[result.finish![0].id];
  }

  // FIFO: whoever has been waiting the longest
  assertEquals(served(QueueDiscipline.FIFO, true), "filtered");
  assertEquals(served(QueueDiscipline.FIFO, false), "unconditional");

  // LIFO: whoever arrived last
  assertEquals(served(QueueDiscipline.LIFO, true), "unconditional");
  assertEquals(served(QueueDiscipline.LIFO, false), "filtered");
});

Deno.test("cancel withdraws a blocked get: a later put no longer resumes it", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "A" } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id, foo: "B" } },
  });
  const blockedA = get(sim, consumerA, store.id);
  const blockedB = get(sim, consumerB, store.id);
  assertEquals(blockedA.item, undefined);
  assertEquals(sim.stores[store.id].getRequests.entries.length, 2);

  const result = cancel(sim, consumerA, store.id, blockedA.step);

  assert(result);
  assert(!result.step.waiting);
  assertEquals(result.step.parent, consumerA.id);
  assertEquals(result.finish, [blockedA.step]);
  assertEquals(sim.stores[store.id].getRequests.entries.length, 1);

  // The next item goes to the remaining consumer, not to the withdrawn one
  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "item" } },
  });
  const delivered = put(sim, producer, store.id, {
    store: store.id,
    foo: "item",
  });

  assertEquals(delivered.finish, [blockedB.step]);
  assertEquals(sim.stores[store.id].getRequests.entries.length, 0);
});

Deno.test("cancel withdraws a blocked put: its item is never delivered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
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
  put(sim, producerB, store.id, { store: store.id, foo: "B" });

  const result = cancel(sim, producerA, store.id, blockedA.step);

  assert(result);
  assertEquals(result.finish, [blockedA.step]);
  assertEquals(sim.stores[store.id].putRequests.entries.length, 1);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id } },
  });
  const received = get(sim, consumer, store.id);

  assertEquals(received.step.process.data?.["foo"], "B");
});

Deno.test("cancel withdraws a blocked getWhere", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, store);
  sim.predicates["isBar"] = (event) => event.process?.data?.["foo"] === "bar";

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const blocked = getWhere(sim, consumer, store.id, "isBar");
  assertEquals(sim.stores[store.id].getWhereRequests.length, 1);

  const result = cancel(sim, consumer, store.id, blocked.step);

  assert(result);
  assertEquals(result.finish, [blocked.step]);
  assertEquals(sim.stores[store.id].getWhereRequests.length, 0);

  // A matching item is now buffered instead of handed to the withdrawn consumer
  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "bar" } },
  });
  const buffered = put(sim, producer, store.id, {
    store: store.id,
    foo: "bar",
  });

  assertEquals(buffered.resume, undefined);
  assertEquals(sim.stores[store.id].buffer.entries.length, 1);
});

Deno.test("cancel returns null when the request has already been served", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: store.id } },
  });
  const blocked = get(sim, consumer, store.id);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: store.id, foo: "bar" } },
  });
  put(sim, producer, store.id, { store: store.id, foo: "bar" });

  const before = sim.stores[store.id];

  assertEquals(cancel(sim, consumer, store.id, blocked.step), null);
  assertEquals(sim.stores[store.id], before);
});

Deno.test("waiting for an item or a timeout resumes the process once", async () => {
  interface WaitData extends StateData {
    why?: string;
    foo?: string;
    request?: string;
    timeout?: string;
  }

  // Runs one waiter that gives up at t=5, and a sender putting an item at `sendAt`
  async function race(sendAt: number) {
    const sim = initializeSimulation();
    const store = initializeStore({ id: "mailbox", capacity: 1 });
    sim.stores = registerStore(sim, store);
    const outcomes: string[] = [];

    const waiter: ProcessDefinition<{
      start: WaitData;
      stop: WaitData;
    }> = {
      type: "waiter",
      initial: "start",
      steps: {
        start(sim, event, state) {
          const { step: request } = get(sim, event, store.id);
          const timeout = continueEvent<WaitData>(event, 5, { why: "timeout" });

          return {
            state: {
              ...state,
              step: "stop",
              data: { request: request.id, timeout: timeout.id },
            },
            next: [request, timeout],
          };
        },
        stop(sim, event, state) {
          const { why, foo, request, timeout } = state.data;

          // Item arrived first: cancel the timeout
          if (why !== "timeout") {
            outcomes.push(`item ${foo}`);
            return {
              state,
              next: [],
              finish: [sim.timeline.events[timeout!]],
            };
          }

          // Timeout fired: withdraw the request from the store
          const withdrawn = cancel(
            sim,
            event,
            store.id,
            sim.timeline.events[request!],
          );

          // Request served at this very time: stand down, the item's continuation carries on
          if (!withdrawn) return { state, next: [] };

          outcomes.push("timeout");
          return { state, next: [], finish: withdrawn.finish };
        },
      },
    };

    const sender: ProcessDefinition<{
      start: WaitData;
    }> = {
      type: "sender",
      initial: "start",
      steps: {
        start(sim, event, state) {
          const { resume, finish } = put(sim, event, store.id, { foo: "bar" });
          return { state, next: resume ?? [], finish: finish ?? [] };
        },
      },
    };

    sim.processes = registerProcess(sim, waiter);
    sim.processes = registerProcess(sim, sender);

    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: 0, process: { type: "waiter" } }),
    );
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: sendAt, process: { type: "sender" } }),
    );

    const { result } = await runSimulation(sim);

    return { outcomes, store: result.stores[store.id] };
  }

  // Item first: the timeout never fires
  const early = await race(2);
  assertEquals(early.outcomes, ["item bar"]);
  assertEquals(early.store.buffer.entries.length, 0);

  // Item and timeout at the same time, item handed over first: the timeout stands down
  const tie = await race(5);
  assertEquals(tie.outcomes, ["item bar"]);
  assertEquals(tie.store.buffer.entries.length, 0);

  // Timeout first: the late item stays in the store instead of resuming the waiter
  const late = await race(9);
  assertEquals(late.outcomes, ["timeout"]);
  assertEquals(late.store.getRequests.entries.length, 0);
  assertEquals(late.store.buffer.entries.length, 1);
});

Deno.test("store operations are checked against the stores a process declares", async () => {
  interface Token extends StateData {
    tokenId: string;
  }

  interface Job extends StateData {
    jobId: number;
    tokenId?: string;
  }

  // Store ID to item type
  type Stores = { pool: Token };

  const sim = initializeSimulation();
  sim.stores = registerStore(
    sim,
    initializeStore({ id: "pool", capacity: 1 }),
  );
  put(sim, createEvent({ scheduledAt: 0 }), "pool", { tokenId: "T1" });

  const seen: string[] = [];

  const job: ProcessDefinition<{
    acquire: Job;
    release: Job;
    done: Job;
  }, Stores> = {
    type: "job",
    initial: "acquire",
    steps: {
      acquire(sim, event, state) {
        const { step, item, resume, finish } = get(sim, event, "pool");

        // The item is typed by the store, not by the caller
        const token: Token | undefined = item;
        seen.push(`job ${state.data.jobId} acquired ${token?.tokenId}`);

        return {
          state: { ...state, step: "release" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      release(sim, event, state) {
        // An item of another type than the caller's data, put with the caller's own event
        const { step, resume, finish } = put(sim, event, "pool", {
          tokenId: state.data.tokenId!,
        });

        return {
          state: { ...state, step: "done" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      done(_sim, _event, state) {
        seen.push(`job ${state.data.jobId} done`);
        return { state, next: [] };
      },
    },
  };

  // Never called: only checks what the compiler rejects
  const _rejected: ProcessHandler<{ acquire: Job }, "acquire", Stores> = (
    sim,
    event,
    state,
  ) => {
    // @ts-expect-error: `pool` holds tokens, not jobs
    put(sim, event, "pool", { jobId: 1 });
    // @ts-expect-error: `queue` is not a declared store
    get(sim, event, "queue");

    return { state, next: [] };
  };

  sim.processes = registerProcess(sim, job);
  sim.timeline = scheduleEvent(
    sim,
    createEvent({
      scheduledAt: 1,
      process: { type: "job", data: { jobId: 7 } },
    }),
  );

  const { result } = await runSimulation(sim);

  assertEquals(seen, ["job 7 acquired T1", "job 7 done"]);
  assertEquals(result.stores["pool"].buffer.entries.length, 1);
});
