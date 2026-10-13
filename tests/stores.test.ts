import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import type {
  DisciplineDefinition,
  Event,
  PredicateDefinition,
  ProcessDefinition,
  ProcessHandler,
  Simulation,
  StateData,
  StoreID,
  StoreItemMap,
} from "../src/model.ts";
import { EventStatus, QueueDiscipline } from "../src/model.ts";
import {
  cancel,
  get,
  getWhere,
  initializeStore,
  put,
  registerStore,
  reorderStore,
} from "../src/stores.ts";
import { historyStates } from "../src/memory.ts";
import { runSimulation } from "../src/runner.ts";
import {
  continueEvent,
  createEvent,
  initializeSimulation,
  registerDiscipline,
  registerPredicate,
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

/** A discipline that no test registers */
const unregistered: DisciplineDefinition = {
  type: "unregistered",
  comparator: (a, b) => a.seq - b.seq,
};

Deno.test("producer-consumer synchronization with a synchronous store", async () => {
  const sim: Simulation<Record<StoreID, FooData>> = {
    ...initializeSimulation(),
    stores: { store: initializeStore({}) },
  };

  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  const e1 = createEvent({
    scheduledAt: 0,
    process: { type: "prod", data: { store: "store", foo: "bar" } },
  });

  const e2 = createEvent({
    scheduledAt: 5,
    process: { type: "cons", data: { store: "store" } },
  });

  const e3 = createEvent({
    scheduledAt: 10,
    process: { type: "cons", data: { store: "store" } },
  });

  const e4 = createEvent({
    scheduledAt: 15,
    process: { type: "prod", data: { store: "store", foo: "baz" } },
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
  const sim: Simulation<Record<StoreID, FooData>> = {
    ...initializeSimulation(),
    stores: { store: initializeStore({}) },
  };

  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // Consumer blocks first, producer resumes it later
  const e1 = createEvent({
    scheduledAt: 0,
    process: { type: "cons", data: { store: "store" } },
  });
  const e2 = createEvent({
    scheduledAt: 5,
    process: { type: "prod", data: { store: "store", foo: "bar" } },
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
  sim.stores = registerStore(sim, "store", store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });

  const waitA = get(sim, consumerA, "store");
  const waitB = get(sim, consumerB, "store");
  assert(waitA.step.waiting);
  assert(waitB.step.waiting);
  assertEquals(sim.stores["store"].getRequests.entries.length, 2);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "x" } },
  });
  const putResult = put(sim, producer, "store", { store: "store", foo: "x" });

  assert(putResult.resume);
  assert(putResult.resume[0]);
  assertEquals(putResult.resume[0].parent, consumerA.id);
  assertEquals(sim.stores["store"].getRequests.entries.length, 1);
});

Deno.test("multiple producers with delayed consumers", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });

  const blockedA = put(sim, producerA, "store", { store: "store", foo: "A" });
  const blockedB = put(sim, producerB, "store", { store: "store", foo: "B" });
  assert(blockedA.step.waiting);
  assert(blockedB.step.waiting);
  assertEquals(sim.stores["store"].putRequests.entries.length, 2);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const getResult = get(sim, consumer, "store");

  assert(getResult.resume);
  assert(getResult.resume[0]);
  assertEquals(getResult.step.process.data?.["foo"], "A");
  // Producer A is resumed, and its continuation does not carry the item back
  assertEquals(getResult.finish, [blockedA.step]);
  assertEquals(getResult.resume[0].process.data, undefined);
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
});

Deno.test("buffered store with capacity > 1", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 2,
  });
  sim.stores = registerStore(sim, "store", store);

  const a = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const b = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });
  const c = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "C" } },
  });

  const r1 = put(sim, a, "store", { store: "store", foo: "A" });
  const r2 = put(sim, b, "store", { store: "store", foo: "B" });
  const r3 = put(sim, c, "store", { store: "store", foo: "C" });

  assert(!r1.step.waiting);
  assert(!r2.step.waiting);
  assert(r3.step.waiting);
  assertEquals(sim.stores["store"].buffer.entries.length, 2);
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
});

Deno.test("store with capacity 0 (requests will block)", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 0,
  });
  sim.stores = registerStore(sim, "store", store);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const result = put(sim, producer, "store", { store: "store", foo: "A" });

  assert(result.step.waiting);
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
  assertEquals(sim.stores["store"].buffer.entries.length, 0);
});

Deno.test("buffered store basic put/get operations", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 1,
  });
  sim.stores = registerStore(sim, "store", store);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const putResult = put(sim, producer, "store", {
    store: "store",
    foo: "A",
  });
  assert(!putResult.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const getResult = get(sim, consumer, "store");
  assertEquals(getResult.step.process.data?.["foo"], "A");
  assertEquals(sim.stores["store"].buffer.entries.length, 0);
});

Deno.test("buffered store LIFO behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 2,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });

  put(sim, producerA, "store", { store: "store", foo: "A" });
  put(sim, producerB, "store", { store: "store", foo: "B" });

  const consumer1 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const consumer2 = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store" } },
  });

  const first = get(sim, consumer1, "store");
  const second = get(sim, consumer2, "store");

  assertEquals(first.step.process.data?.["foo"], "B");
  assertEquals(second.step.process.data?.["foo"], "A");
});

Deno.test("buffered store FIFO behavior", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 2,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });

  put(sim, producerA, "store", { store: "store", foo: "A" });
  put(sim, producerB, "store", { store: "store", foo: "B" });

  const consumer1 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const consumer2 = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store" } },
  });

  const first = get(sim, consumer1, "store");
  const second = get(sim, consumer2, "store");

  assertEquals(first.step.process.data?.["foo"], "A");
  assertEquals(second.step.process.data?.["foo"], "B");
});

Deno.test("buffered store at capacity serves buffer before blocked producers", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 1,
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });

  put(sim, producerA, "store", { store: "store", foo: "A" });
  const blocked = put(sim, producerB, "store", { store: "store", foo: "B" });

  assert(blocked.step.waiting);

  const consumer1 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const consumer2 = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store" } },
  });

  const first = get(sim, consumer1, "store");

  // Buffered item is delivered; blocked producer takes the freed slot and resumes
  assertEquals(first.item?.["foo"], "A");
  assertEquals(first.step.process.data?.["foo"], "A");
  assertEquals(first.resume?.length, 1);
  assertEquals(first.finish, [blocked.step]);
  assertEquals(sim.stores["store"].putRequests.entries.length, 0);
  assertEquals(sim.stores["store"].buffer.entries.length, 1);

  const second = get(sim, consumer2, "store");

  assertEquals(second.step.process.data?.["foo"], "B");
  assertEquals(sim.stores["store"].buffer.entries.length, 0);
});

Deno.test("buffered LIFO store at capacity applies discipline per queue", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 1,
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  for (const foo of ["A", "B", "C"]) {
    const producer = createEvent<FooData>({
      scheduledAt: 0,
      process: { type: "none", data: { store: "store", foo } },
    });
    put(sim, producer, "store", { store: "store", foo });
  }

  assertEquals(sim.stores["store"].buffer.entries.length, 1);
  assertEquals(sim.stores["store"].putRequests.entries.length, 2);

  const received = Array.from({ length: 3 }, () => {
    const consumer = createEvent<FooData>({
      scheduledAt: 1,
      process: { type: "none", data: { store: "store" } },
    });
    return get(sim, consumer, "store").step.process.data?.["foo"];
  });

  // A is the only buffered item; blocked producers then take the freed slot in LIFO order
  assertEquals(received, ["A", "C", "B"]);
  assertEquals(sim.stores["store"].buffer.entries.length, 0);
  assertEquals(sim.stores["store"].putRequests.entries.length, 0);
});

Deno.test("blocked gets resume in LIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    consumerDiscipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });

  const waitA = get(sim, consumerA, "store");
  const waitB = get(sim, consumerB, "store");
  assert(waitA.step.waiting);
  assert(waitB.step.waiting);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "payload" } },
  });
  const result = put(sim, producer, "store", {
    store: "store",
    foo: "payload",
  });

  assert(result.resume);
  assert(result.resume[0]);
  assertEquals(result.resume[0].parent, consumerB.id);
});

Deno.test("a store orders its items and its blocked consumers under separate disciplines", () => {
  // Which item a `get` takes out of two, and which of two blocked consumers a `put` serves
  const order = (options: {
    discipline?: QueueDiscipline;
    consumerDiscipline?: QueueDiscipline;
  }) => {
    const event = () => createEvent({ scheduledAt: 0 });

    const sim = initializeSimulation();
    sim.stores = registerStore(
      sim,
      "items",
      initializeStore({ ...options, capacity: 2 }),
    );
    sim.stores = registerStore(sim, "consumers", initializeStore(options));

    put(sim, event(), "items", { item: "first" });
    put(sim, event(), "items", { item: "second" });
    const taken = get(sim, event(), "items").item?.["item"];

    const requests = [
      get(sim, event(), "consumers").step,
      get(
        sim,
        event(),
        "consumers",
      ).step,
    ];
    const served = put(sim, event(), "consumers", {}).finish?.[0];

    return [taken, served === requests[0] ? "first" : "second"];
  };

  assertEquals(order({}), ["first", "first"]);
  assertEquals(order({ discipline: QueueDiscipline.LIFO }), [
    "second",
    "first",
  ]);
  assertEquals(order({ consumerDiscipline: QueueDiscipline.LIFO }), [
    "first",
    "second",
  ]);
});

Deno.test("blocked gets resume in FIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });

  const waitA = get(sim, consumerA, "store");
  const waitB = get(sim, consumerB, "store");
  assert(waitA.step.waiting);
  assert(waitB.step.waiting);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "payload" } },
  });
  const result = put(sim, producer, "store", {
    store: "store",
    foo: "payload",
  });

  assert(result.resume);
  assert(result.resume[0]);
  assertEquals(result.resume[0].parent, consumerA.id);
});

Deno.test("blocked put resumes get with preserved payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);

  const producer = createEvent({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "bar" } },
  });

  const blockedPut = put(sim, producer, "store", {
    store: "store",
    foo: "bar",
  });
  assertEquals(blockedPut.resume, undefined);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const resumedGet = get(sim, consumer, "store");

  assertEquals(resumedGet.step.process.data?.["foo"], "bar");
  assert(resumedGet.resume);
});

Deno.test("buffered put returns payload on later get", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 2 });
  sim.stores = registerStore(sim, "store", store);

  const producer = createEvent({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "baz" } },
  });

  const bufferedPut = put(sim, producer, "store", {
    store: "store",
    foo: "baz",
  });
  assertEquals(bufferedPut.resume, undefined);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const bufferedGet = get(sim, consumer, "store");

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
  sim.stores = registerStore(sim, "store", store);

  const missingPayloadPut = createEvent<FooData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none" },
  });
  sim.stores["store"].putRequests = {
    entries: [{ event: missingPayloadPut, seq: 0 }],
    seq: 1,
  };

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });

  assertThrows(
    () => get(sim, consumer, "store"),
    TypeError,
    "Store payload is missing for event:",
  );
});

Deno.test("get throws when buffered item has no payload", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    capacity: 2,
  });
  sim.stores = registerStore(sim, "store", store);

  const missingPayloadBuffered = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none" },
  });
  sim.stores["store"].buffer = {
    entries: [{ event: missingPayloadBuffered, seq: 0 }],
    seq: 1,
  };

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });

  assertThrows(
    () => get(sim, consumer, "store"),
    TypeError,
    "Store payload is missing for event:",
  );
});

Deno.test("process step unblocks multiple consumers", async () => {
  const sim: Simulation<Record<StoreID, FooData>> = {
    ...initializeSimulation(),
    stores: {
      store: initializeStore({
        discipline: QueueDiscipline.FIFO,
      }),
    },
  };
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // 3 consumers arrive first and block (no producers yet)
  const c1 = createEvent({
    scheduledAt: 0,
    process: { type: "cons", data: { store: "store" } },
  });
  const c2 = createEvent({
    scheduledAt: 1,
    process: { type: "cons", data: { store: "store" } },
  });
  const c3 = createEvent({
    scheduledAt: 2,
    process: { type: "cons", data: { store: "store" } },
  });

  // 3 producers arrive later, each unblocking one consumer in FIFO order
  const p1 = createEvent({
    scheduledAt: 10,
    process: { type: "prod", data: { store: "store", foo: "first" } },
  });
  const p2 = createEvent({
    scheduledAt: 11,
    process: { type: "prod", data: { store: "store", foo: "second" } },
  });
  const p3 = createEvent({
    scheduledAt: 12,
    process: { type: "prod", data: { store: "store", foo: "third" } },
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
  const sim: Simulation<Record<StoreID, FooData>> = {
    ...initializeSimulation(),
    stores: {
      store: initializeStore({
        discipline: QueueDiscipline.FIFO,
      }),
    },
  };
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // 3 producers arrive first and block (no consumers yet)
  const p1 = createEvent({
    scheduledAt: 0,
    process: { type: "prod", data: { store: "store", foo: "first" } },
  });
  const p2 = createEvent({
    scheduledAt: 1,
    process: { type: "prod", data: { store: "store", foo: "second" } },
  });
  const p3 = createEvent({
    scheduledAt: 2,
    process: { type: "prod", data: { store: "store", foo: "third" } },
  });

  // 3 consumers arrive later, each unblocking one producer in FIFO order
  const c1 = createEvent({
    scheduledAt: 10,
    process: { type: "cons", data: { store: "store" } },
  });
  const c2 = createEvent({
    scheduledAt: 11,
    process: { type: "cons", data: { store: "store" } },
  });
  const c3 = createEvent({
    scheduledAt: 12,
    process: { type: "cons", data: { store: "store" } },
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
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });

  const blockedA = put(sim, producerA, "store", { store: "store", foo: "A" });
  const blockedB = put(sim, producerB, "store", { store: "store", foo: "B" });
  assert(blockedA.step.waiting);
  assert(blockedB.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store" } },
  });
  const result = get(sim, consumer, "store");

  // FIFO: A was enqueued first, so it is dequeued first
  assert(result.resume);
  assertEquals(result.resume[0].parent, producerA.id);
  assertEquals(result.step.process.data?.["foo"], "A");
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
});

Deno.test("blocked puts resume in LIFO order", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });

  const blockedA = put(sim, producerA, "store", { store: "store", foo: "A" });
  const blockedB = put(sim, producerB, "store", { store: "store", foo: "B" });
  assert(blockedA.step.waiting);
  assert(blockedB.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store" } },
  });
  const result = get(sim, consumer, "store");

  // LIFO: B was enqueued last, so it is dequeued first
  assert(result.resume);
  assertEquals(result.resume[0].parent, producerB.id);
  assertEquals(result.step.process.data?.["foo"], "B");
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
});

Deno.test("buffered store get on empty buffer blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 2 });
  sim.stores = registerStore(sim, "store", store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const result = get(sim, consumer, "store");

  assert(result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores["store"].getRequests.entries.length, 1);
});

Deno.test("request is marked Finished after unblocking", async () => {
  const sim: Simulation<Record<StoreID, FooData>> = {
    ...initializeSimulation(),
    stores: { store: initializeStore({}) },
  };
  sim.processes = registerProcess(sim, prod);
  sim.processes = registerProcess(sim, cons);

  // Consumer blocks first, creating a request
  const consumer = createEvent({
    scheduledAt: 0,
    process: { type: "cons", data: { store: "store" } },
  });
  // Producer arrives later and unblocks the consumer
  const producer = createEvent({
    scheduledAt: 5,
    process: { type: "prod", data: { store: "store", foo: "data" } },
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
  sim.stores = registerStore(sim, "store", store);
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", hasFoo);

  assert(result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);
  assertEquals(
    sim.stores["store"].getWhereRequests[0].predicateType,
    "hasFoo",
  );
});

Deno.test("getWhere errors on missing store", () => {
  const sim = initializeSimulation();
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "missing" } },
  });
  assertThrows(
    () => getWhere(sim, consumer, "missing", hasFoo),
    RangeError,
    "Store not found",
  );
});

Deno.test("getWhere predicates see the consumer's request", () => {
  interface Parcel extends StateData {
    to: string;
  }

  interface Resident extends StateData {
    name: string;
  }

  const mine: PredicateDefinition<Parcel, "mine", Resident> = {
    type: "mine",
    predicate: (item, request) =>
      item.process.data?.to === request.process.data?.name,
  };

  const build = () => {
    const sim = initializeSimulation();
    sim.stores = registerStore(sim, "lobby", initializeStore({ capacity: 2 }));
    sim.predicates = registerPredicate(sim, mine);
    return sim;
  };
  const resident = (name: string) =>
    createEvent<Resident>({
      scheduledAt: 0,
      process: { type: "none", data: { name } },
    });

  // Item already there: taken by the consumer it is for, the other one blocks
  const buffered = build();
  put(buffered, createEvent({ scheduledAt: 0 }), "lobby", { to: "Bob" });

  const ada = getWhere(buffered, resident("Ada"), "lobby", mine);
  assert(ada.step.waiting);
  assertEquals(ada.item, undefined);

  const bob = getWhere(buffered, resident("Bob"), "lobby", mine);
  assert(!bob.step.waiting);
  assertEquals(bob.item, { to: "Bob" });

  // Consumers already blocked: the item resumes the one it is for, whatever their order
  const blocked = build();
  const first = getWhere(blocked, resident("Ada"), "lobby", mine);
  const second = getWhere(blocked, resident("Bob"), "lobby", mine);

  const forBob = put(blocked, createEvent({ scheduledAt: 0 }), "lobby", {
    to: "Bob",
  });
  assertEquals(forBob.finish, [second.step]);

  // An item for nobody waiting is buffered
  const forCleo = put(blocked, createEvent({ scheduledAt: 0 }), "lobby", {
    to: "Cleo",
  });
  assertEquals(forCleo.resume, undefined);
  assertEquals(blocked.stores["lobby"].buffer.entries.length, 1);
  assertEquals(blocked.stores["lobby"].getWhereRequests.length, 1);
  assertEquals(blocked.stores["lobby"].getWhereRequests[0].event, first.step);
});

Deno.test("what an event brings is left on the event, not merged into the process data", async () => {
  interface Letter extends StateData {
    letter: number;
  }

  interface Note extends StateData {
    note: string;
  }

  interface Reader extends StateData {
    name: string;
  }

  // Runs one reader asking for a letter at t=1; the letter is sent at `sendAt`, before or after
  async function read(sendAt: number) {
    const sim: Simulation<{ box: Letter }> = {
      ...initializeSimulation(),
      stores: { box: initializeStore({ capacity: 1 }) },
    };
    const seen: unknown[] = [];

    const reader: ProcessDefinition<
      { ask: Reader; got: Reader; after: Reader },
      { box: Letter },
      { got: Letter; after: Note }
    > = {
      type: "reader",
      initial: "ask",
      steps: {
        ask(sim, event, state) {
          const { step, resume, finish } = get(sim, event, "box");
          return {
            state: { ...state, step: "got" },
            next: resume ? [step, ...resume] : [step],
            finish,
          };
        },
        got(sim, event, state) {
          seen.push([state.data, event.process.data]);
          return {
            state: { ...state, step: "after" },
            next: [continueEvent(event, sim.currentTime, { note: "read" })],
          };
        },
        after(_sim, event, state) {
          seen.push([state.data, event.process.data]);
          return { state, next: [] };
        },
      },
    };

    const sender: ProcessDefinition<{ send: StateData }, { box: Letter }> = {
      type: "sender",
      initial: "send",
      steps: {
        send(sim, event, state) {
          const { resume, finish } = put(sim, event, "box", { letter: 1 });
          return { state, next: resume ?? [], finish };
        },
      },
    };

    sim.processes = registerProcess(sim, reader);
    sim.processes = registerProcess(sim, sender);
    sim.timeline = scheduleEvent(
      sim,
      createEvent({
        scheduledAt: 1,
        process: { type: "reader", data: { name: "Ada" } },
      }),
    );
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: sendAt, process: { type: "sender" } }),
    );

    await runSimulation(sim);

    return seen;
  }

  // An item, then the data of a continuation: each on its event, the process data as returned by the step before
  const expected = [
    [{ name: "Ada" }, { letter: 1 }],
    [{ name: "Ada" }, { note: "read" }],
  ];

  // Letter buffered first: the reader's `get` completes immediately
  assertEquals(await read(0), expected);

  // Letter sent later: the reader blocks, then is resumed
  assertEquals(await read(2), expected);
});

Deno.test("a consumer's request carries the data of its process", async () => {
  interface Parcel extends StateData {
    to?: string;
  }

  interface Resident extends StateData {
    name?: string;
    floor?: number;
    to?: string;
  }

  const highest: DisciplineDefinition<"highest", Resident> = {
    type: "highest",
    comparator: (a, b) =>
      (b.event.process.data?.floor ?? 0) - (a.event.process.data?.floor ?? 0),
  };

  const sim = initializeSimulation();
  sim.stores = registerStore(sim, "lobby", initializeStore({}));
  sim.stores = registerStore(
    sim,
    "lift",
    initializeStore({ consumerDiscipline: highest }),
  );
  const mine: PredicateDefinition<Parcel, "mine", Resident> = {
    type: "mine",
    predicate: (item, request) =>
      item.process.data?.to === request.process.data?.name,
  };
  sim.predicates = registerPredicate(sim, mine);
  sim.disciplines = registerDiscipline(sim, highest);

  const received: string[] = [];

  // `name` and `floor` are set by the first step, in the state: the event that runs the second step carries no data
  const resident = (
    type: string,
    name: string,
    floor: number,
    ask: ProcessHandler<
      { settle: Resident; ask: Resident; done: Resident },
      "ask"
    >,
  ): ProcessDefinition<
    { settle: Resident; ask: Resident; done: Resident }
  > => ({
    type,
    initial: "settle",
    steps: {
      settle(sim, event, state) {
        return {
          state: { ...state, step: "ask", data: { name, floor } },
          next: [continueEvent(event, sim.currentTime)],
        };
      },
      ask,
      done(_sim, event, state) {
        received.push(`${state.data.name} ${event.process.data?.["to"]}`);
        return { state, next: [] };
      },
    },
  });

  // Ada and Bob wait for their own parcel in the lobby; Cleo and Dan for the lift, highest floor first
  const forParcel: ProcessHandler<
    { settle: Resident; ask: Resident; done: Resident },
    "ask"
  > = (sim, event, state) => {
    const { step, resume, finish } = getWhere(sim, event, "lobby", mine);
    return {
      state: { ...state, step: "done" },
      next: resume ? [step, ...resume] : [step],
      finish,
    };
  };
  const forLift: ProcessHandler<
    { settle: Resident; ask: Resident; done: Resident },
    "ask"
  > = (sim, event, state) => {
    const { step, resume, finish } = get(sim, event, "lift");
    return {
      state: { ...state, step: "done" },
      next: resume ? [step, ...resume] : [step],
      finish,
    };
  };

  const sender: ProcessDefinition<{ send: StateData }> = {
    type: "sender",
    initial: "send",
    steps: {
      send(sim, event, state) {
        const sent = [
          put(sim, event, "lobby", { to: "Bob" }),
          put(sim, event, "lift", { to: "top" }),
        ];
        return {
          state,
          next: sent.flatMap(({ resume }) => resume ?? []),
          finish: sent.flatMap(({ finish }) => finish ?? []),
        };
      },
    },
  };

  sim.processes = registerProcess(sim, resident("ada", "Ada", 1, forParcel));
  sim.processes = registerProcess(sim, resident("bob", "Bob", 2, forParcel));
  sim.processes = registerProcess(sim, resident("cleo", "Cleo", 3, forLift));
  sim.processes = registerProcess(sim, resident("dan", "Dan", 7, forLift));
  sim.processes = registerProcess(sim, sender);
  for (const type of ["ada", "bob", "cleo", "dan"]) {
    sim.timeline = scheduleEvent(
      sim,
      createEvent({ scheduledAt: 0, process: { type } }),
    );
  }
  sim.timeline = scheduleEvent(
    sim,
    createEvent({ scheduledAt: 1, process: { type: "sender" } }),
  );

  const { result } = await runSimulation(sim);

  // The predicate matched Bob by his name, and the discipline ranked Dan by his floor
  assertEquals(received.sort(), ["Bob Bob", "Dan top"]);

  // Ada and Cleo still wait, their requests carrying their process data
  assertEquals(
    result.stores["lobby"].getWhereRequests.map((request) =>
      request.event.process.data
    ),
    [{ name: "Ada", floor: 1 }],
  );
  assertEquals(
    result.stores["lift"].getRequests.entries.map((entry) =>
      entry.event.process.data
    ),
    [{ name: "Cleo", floor: 3 }],
  );
});

Deno.test("getWhere errors when another predicate is registered under the key of its definition", () => {
  const sim = initializeSimulation();
  sim.stores = registerStore(sim, "store", initializeStore({ capacity: 1 }));

  const any: PredicateDefinition = { type: "pick", predicate: () => true };
  const none: PredicateDefinition = { type: "pick", predicate: () => false };
  sim.predicates = registerPredicate(sim, any);
  sim.predicates = registerPredicate(sim, none);

  put(sim, createEvent({ scheduledAt: 0 }), "store", { foo: "bar" });

  // `any` was replaced: the predicate that would run is not the one passed
  assertThrows(
    () => getWhere(sim, createEvent({ scheduledAt: 0 }), "store", any),
    RangeError,
    "Predicate in registry is not the one of the definition: pick",
  );

  // `none` is the one registered: it runs, and rejects the item
  assert(
    getWhere(sim, createEvent({ scheduledAt: 0 }), "store", none).step.waiting,
  );
});

Deno.test("getWhere errors on unregistered predicate key", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const noSuchPredicate: PredicateDefinition = {
    type: "noSuchPredicate",
    predicate: () => true,
  };
  assertThrows(
    () => getWhere(sim, consumer, "store", noSuchPredicate),
    RangeError,
    "Predicate not found in registry: noSuchPredicate",
  );
});

Deno.test("getWhere matches blocked producer in putRequests immediately", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "hello" } },
  });
  put(sim, producer, "store", { store: "store", foo: "hello" });
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", hasFoo);

  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "hello");
  assert(result.resume);
  assertEquals(result.finish?.length, 1);
  assertEquals(sim.stores["store"].putRequests.entries.length, 0);
});

Deno.test("getWhere skips non-matching putRequests and blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);
  // predicate requires foo === "bar"
  const isBar: PredicateDefinition = {
    type: "isBar",
    predicate: (event) => event.process?.data?.["foo"] === "bar",
  };
  sim.predicates = registerPredicate(sim, isBar);

  const producer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "other" } },
  });
  put(sim, producer, "store", { store: "store", foo: "other" });

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", isBar);

  assert(result.step.waiting);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);
  // non-matching producer still in putRequests
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
});

Deno.test("getWhere matches item in buffer immediately", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 3 });
  sim.stores = registerStore(sim, "store", store);
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "buffered" } },
  });
  put(sim, p1, "store", { store: "store" }); // no foo: won't match
  put(sim, p2, "store", { store: "store", foo: "buffered" }); // matches
  assertEquals(sim.stores["store"].buffer.entries.length, 2);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", hasFoo);

  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "buffered");
  assertEquals(result.resume, undefined);
  // the matching item was consumed, only the non-matching one remains
  assertEquals(sim.stores["store"].buffer.entries.length, 1);
});

Deno.test("getWhere skips non-matching buffer items and blocks", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 2 });
  sim.stores = registerStore(sim, "store", store);
  const isBar: PredicateDefinition = {
    type: "isBar",
    predicate: (event) => event.process?.data?.["foo"] === "bar",
  };
  sim.predicates = registerPredicate(sim, isBar);

  const p = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "other" } },
  });
  put(sim, p, "store", { store: "store", foo: "other" });

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", isBar);

  assert(result.step.waiting);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);
  assertEquals(sim.stores["store"].buffer.entries.length, 1); // item still buffered
});

Deno.test("getWhere on a full buffer: matching buffered item frees a slot for a blocked producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, "store", store);
  const isBar: PredicateDefinition = {
    type: "isBar",
    predicate: (event) => event.process?.data?.["foo"] === "bar",
  };
  sim.predicates = registerPredicate(sim, isBar);

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "bar" } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "other" } },
  });
  put(sim, p1, "store", { store: "store", foo: "bar" }); // buffered
  const blocked = put(sim, p2, "store", { store: "store", foo: "other" }); // blocks
  assert(blocked.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", isBar);

  assertEquals(result.step.process.data?.["foo"], "bar");
  assertEquals(result.resume?.length, 1);
  assertEquals(result.finish, [blocked.step]);
  // the blocked producer's item took the freed slot, whether or not it matches
  assertEquals(sim.stores["store"].putRequests.entries.length, 0);
  assertEquals(
    sim.stores["store"].buffer.entries[0].event.process.data?.["foo"],
    "other",
  );
});

Deno.test("getWhere on a full buffer: falls back to a matching blocked producer", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, "store", store);
  const isBar: PredicateDefinition = {
    type: "isBar",
    predicate: (event) => event.process?.data?.["foo"] === "bar",
  };
  sim.predicates = registerPredicate(sim, isBar);

  const p1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "other" } },
  });
  const p2 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "bar" } },
  });
  put(sim, p1, "store", { store: "store", foo: "other" }); // buffered
  const blocked = put(sim, p2, "store", { store: "store", foo: "bar" }); // blocks
  assert(blocked.step.waiting);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", isBar);

  // direct handoff from the blocked producer: its item never enters the buffer
  assertEquals(result.step.process.data?.["foo"], "bar");
  assertEquals(result.resume?.length, 1);
  assertEquals(result.finish, [blocked.step]);
  assertEquals(sim.stores["store"].putRequests.entries.length, 0);
  assertEquals(
    sim.stores["store"].buffer.entries[0].event.process.data?.["foo"],
    "other",
  );
});

Deno.test("put resolves a matching getWhere request", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  getWhere(sim, consumer, "store", hasFoo);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "match" } },
  });
  const result = put(sim, producer, "store", {
    store: "store",
    foo: "match",
  });

  assert(result.resume);
  assertEquals(result.resume[0].process.data?.["foo"], "match");
  assertEquals(result.finish?.length, 1);
  assertEquals(sim.stores["store"].getWhereRequests.length, 0);
});

Deno.test("put buffers when the getWhere request's predicate does not match", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 3 });
  sim.stores = registerStore(sim, "store", store);
  const isBar: PredicateDefinition = {
    type: "isBar",
    predicate: (event) => event.process?.data?.["foo"] === "bar",
  };
  sim.predicates = registerPredicate(sim, isBar);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  getWhere(sim, consumer, "store", isBar);

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "other" } },
  });
  const result = put(sim, producer, "store", {
    store: "store",
    foo: "other",
  });

  // non-matching put still goes to buffer (buffered store with capacity)
  assert(!result.step.waiting);
  assertEquals(result.resume, undefined);
  assertEquals(sim.stores["store"].buffer.entries.length, 1);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1); // request still queued
});

Deno.test("put with unregistered predicate key in getWhereRequests throws", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);
  // register predicate to call getWhere, then remove it to simulate corruption
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  getWhere(sim, consumer, "store", hasFoo);
  delete sim.predicates["hasFoo"]; // simulate missing predicate

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "x" } },
  });
  assertThrows(
    () => put(sim, producer, "store", { store: "store", foo: "x" }),
    RangeError,
    "Predicate not found in registry: hasFoo",
  );
});

Deno.test("getWhere FIFO: first matching request is served first by put", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, "store", store);
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const w1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const w2 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  getWhere(sim, w1, "store", hasFoo);
  getWhere(sim, w2, "store", hasFoo);
  assertEquals(sim.stores["store"].getWhereRequests.length, 2);

  const producer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store", foo: "x" } },
  });
  const result = put(sim, producer, "store", { store: "store", foo: "x" });

  // FIFO: w1 (index 0) is served
  assert(result.resume);
  assertEquals(result.resume[0].parent, w1.id);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);
});

Deno.test("getWhere LIFO: last matching request is served first by put", () => {
  const sim = initializeSimulation();
  const store = initializeStore({
    consumerDiscipline: QueueDiscipline.LIFO,
  });
  sim.stores = registerStore(sim, "store", store);
  const hasFoo: PredicateDefinition = {
    type: "hasFoo",
    predicate: (event) => typeof event.process?.data?.["foo"] === "string",
  };
  sim.predicates = registerPredicate(sim, hasFoo);

  const w1 = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const w2 = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  getWhere(sim, w1, "store", hasFoo);
  getWhere(sim, w2, "store", hasFoo);

  const producer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store", foo: "x" } },
  });
  const result = put(sim, producer, "store", { store: "store", foo: "x" });

  // LIFO: w2 (index 1, last in) is served
  assert(result.resume);
  assertEquals(result.resume[0].parent, w2.id);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);
});

Deno.test("getWhere integration: full round-trip through runSimulation", async () => {
  interface TaskData extends StateData {
    taskId: number;
    urgent: boolean;
  }

  const TASK_STORE = "tasks" as const;

  const sim = initializeSimulation();
  const isUrgent: PredicateDefinition = {
    type: "isUrgent",
    predicate: (event) => event.process?.data?.["urgent"] === true,
  };
  sim.predicates = registerPredicate(sim, isUrgent);

  const store = initializeStore({
    capacity: 10,
  });
  sim.stores = registerStore(sim, TASK_STORE, store);

  // Scheduler process: waits for an urgent task using getWhere
  const scheduler: ProcessDefinition<
    {
      wait: TaskData;
      run: TaskData;
    },
    StoreItemMap,
    { run: TaskData }
  > = {
    type: "scheduler",
    initial: "wait",
    steps: {
      wait(sim, event, state) {
        const { step, resume, finish } = getWhere(
          sim,
          event,
          TASK_STORE,
          isUrgent,
        );
        return {
          state: { ...state, step: "run" },
          next: resume ? [step, ...resume] : [step],
          finish: finish ?? [],
        };
      },
      run(_sim, event, state) {
        return { state: { ...state, data: event.process.data }, next: [] };
      },
    },
  };

  sim.processes = registerProcess(sim, scheduler);

  // Producer process: buffers a non-urgent task then an urgent task.
  // The non-urgent put seeds the buffer directly (result discarded, like er-triage
  // seed events); the urgent put resolves the scheduler's getWhere request.
  // A `done` step is required so that updatedPut, a continuation, does not re-enter `go`.
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
  const edf: DisciplineDefinition<"edf", EdfData> = {
    type: "edf",
    comparator: (a, b) =>
      (a.event.process.data?.deadline ?? 0) -
      (b.event.process.data?.deadline ?? 0),
  };
  sim.disciplines = registerDiscipline(sim, edf);

  const store = initializeStore({
    capacity: 3,
    discipline: edf,
  });
  sim.stores = registerStore(sim, "edf-store", store);

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
      capacity: 0,
      discipline: QueueDiscipline.LIFO,
      consumerDiscipline: QueueDiscipline.LIFO,
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
      capacity: 1,
      discipline: QueueDiscipline.LIFO,
      consumerDiscipline: QueueDiscipline.LIFO,
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
  const store = initializeStore({ discipline: unregistered });
  sim.stores = registerStore(sim, "store", store);

  const event = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });

  assertThrows(
    () => put(sim, event, "store", { store: "store" }),
    RangeError,
    "Discipline definition not found in registry: unregistered",
  );
});

Deno.test("get throws when discipline is not registered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ discipline: unregistered });
  sim.stores = registerStore(sim, "store", store);

  const event = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });

  assertThrows(
    () => get(sim, event, "store"),
    RangeError,
    "Discipline definition not found in registry: unregistered",
  );
});

Deno.test("getWhere throws when discipline is not registered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ discipline: unregistered });
  sim.stores = registerStore(sim, "store", store);
  const any: PredicateDefinition = {
    type: "any",
    predicate: () => true,
  };
  sim.predicates = registerPredicate(sim, any);

  const event = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });

  assertThrows(
    () => getWhere(sim, event, "store", any),
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
  const edfFgr: DisciplineDefinition<"edf-fgr", DeadlineData> = {
    type: "edf-fgr",
    comparator: (a, b) =>
      (a.event.process.data?.deadline ?? 0) -
      (b.event.process.data?.deadline ?? 0),
  };
  sim.disciplines = registerDiscipline(sim, edfFgr);

  const store = initializeStore({ consumerDiscipline: edfFgr });
  sim.stores = registerStore(sim, "store", store);
  const anyDeadline: PredicateDefinition = {
    type: "anyDeadline",
    predicate: () => true,
  };
  sim.predicates = registerPredicate(sim, anyDeadline);

  // Two getWhere requests with different deadlines; EDF should serve tighter first.
  const requestA = createEvent<DeadlineData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none", data: { store: "store", deadline: 20 } },
  });
  const requestB = createEvent<DeadlineData>({
    scheduledAt: 0,
    waiting: true,
    process: { type: "none", data: { store: "store", deadline: 10 } },
  });

  sim.stores["store"].getWhereRequests = [
    { event: requestA, predicateType: "anyDeadline", seq: 0 },
    { event: requestB, predicateType: "anyDeadline", seq: 1 },
  ];

  const producer = createEvent<DeadlineData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", deadline: 0 } },
  });
  const result = put(sim, producer, "store", { store: "store", deadline: 0 });

  // requestB (deadline 10) must be served first.
  assert(result.resume);
  assertEquals(result.finish?.[0].id, requestB.id);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);
  assertEquals(
    sim.stores["store"].getWhereRequests[0].event.id,
    requestA.id,
  );
});

Deno.test("multi-store simulation: two stores interact in a single run", async () => {
  // Pipeline: producer → storeA → relay → storeB → consumer
  // The relay process gets from storeA, then puts to storeB.
  // Verifies that independent stores in the same simulation coordinate correctly.
  const sim: Simulation<Record<StoreID, PipeData>> = {
    ...initializeSimulation(),
    stores: {
      storeA: initializeStore({ capacity: 1 }),
      storeB: initializeStore({ capacity: 1 }),
    },
  };

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

  const data: PipeData = { storeA: "storeA", storeB: "storeB" };

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
  assertEquals(result.stores["storeA"].buffer.entries.length, 0);
  assertEquals(result.stores["storeB"].buffer.entries.length, 0);
});

Deno.test("getWhere skips non-matching putRequests and returns the first match", () => {
  // Exercises the re-insertion loop in storeQueuePopWhere: when the discipline-best
  // entry does not satisfy the predicate it is set aside; after a matching entry is
  // found the rejected entries are re-inserted back into the heap.
  const sim = initializeSimulation();
  const store = initializeStore({
    discipline: QueueDiscipline.FIFO,
  });
  sim.stores = registerStore(sim, "store", store);
  const isMatch: PredicateDefinition = {
    type: "isMatch",
    predicate: (event) => event.process?.data?.["foo"] === "match",
  };
  sim.predicates = registerPredicate(sim, isMatch);

  const prodA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "skip" } },
  });
  const prodB = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "match" } },
  });

  put(sim, prodA, "store", { store: "store", foo: "skip" });
  put(sim, prodB, "store", { store: "store", foo: "match" });

  const consumer = createEvent<FooData>({
    scheduledAt: 2,
    process: { type: "none", data: { store: "store" } },
  });
  const result = getWhere(sim, consumer, "store", isMatch);

  // prodB matched; prodA was rejected and re-inserted.
  assert(!result.step.waiting);
  assertEquals(result.step.process.data?.["foo"], "match");
  assert(result.resume);
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);
  assertEquals(
    sim.stores["store"].putRequests.entries[0].event.process.data?.["foo"],
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
    sim.stores = registerStore(sim, "store", store);
    const seen: number[] = [];

    const producer: ProcessDefinition<{
      start: CountData;
      stop: CountData;
    }> = {
      type: "producer",
      initial: "start",
      steps: {
        start(sim, event, state) {
          const { step, resume, finish } = put(sim, event, "store", { n: 1 });

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
          const { step, resume, finish } = get(sim, event, "store");

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
    const store = initializeStore({
      capacity: 1,
      consumerDiscipline: discipline,
    });
    sim.stores = registerStore(sim, "store", store);
    const isBar: PredicateDefinition = {
      type: "isBar",
      predicate: (event) => event.process?.data?.["foo"] === "bar",
    };
    sim.predicates = registerPredicate(sim, isBar);

    const consumer = () =>
      createEvent<FooData>({
        scheduledAt: 0,
        process: { type: "none", data: { store: "store" } },
      });

    const waiting: Record<string, string> = {};
    for (const filtered of [filteredFirst, !filteredFirst]) {
      const { step } = filtered
        ? getWhere(sim, consumer(), "store", isBar)
        : get(sim, consumer(), "store");
      waiting[step.id] = filtered ? "filtered" : "unconditional";
    }

    const producer = createEvent<FooData>({
      scheduledAt: 1,
      process: { type: "none", data: { store: "store", foo: "bar" } },
    });
    const result = put(sim, producer, "store", {
      store: "store",
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

Deno.test("reorderStore reorders queued items under the discipline the store points to", () => {
  interface Job extends StateData {
    size: number;
  }

  const smallest: DisciplineDefinition<"smallest" | "policy", Job> = {
    type: "smallest",
    comparator: (a, b) =>
      (a.event.process.data?.size ?? 0) - (b.event.process.data?.size ?? 0) ||
      a.seq - b.seq,
  };

  const arrival: DisciplineDefinition<"policy", Job> = {
    type: "policy",
    comparator: (a, b) => a.seq - b.seq,
  };

  // Items out of the store, in order
  const drain = (sim: Simulation, n: number) =>
    Array.from(
      { length: n },
      () => get(sim, createEvent({ scheduledAt: 0 }), "queue").item?.["size"],
    );

  // `capacity` 3: three items buffered, two more carried by blocked producers
  const build = () => {
    const sim = initializeSimulation();
    sim.disciplines = registerDiscipline(sim, smallest);
    sim.disciplines = registerDiscipline(sim, arrival);
    sim.stores = registerStore(
      sim,
      "queue",
      initializeStore({ capacity: 3, discipline: arrival }),
    );
    for (const size of [5, 1, 3, 4, 2]) {
      put(sim, createEvent({ scheduledAt: 0 }), "queue", { size });
    }
    return sim;
  };

  // Arrival order to begin with
  assertEquals(drain(build(), 5), [5, 1, 3, 4, 2]);

  // The store is pointed to another discipline
  const pointed = build();
  pointed.stores = {
    ...pointed.stores,
    queue: { ...pointed.stores["queue"], discipline: "smallest" },
  };
  const before = pointed.stores;
  pointed.stores = reorderStore(pointed, "queue");

  // Smallest first: each blocked producer, smallest first too, takes the slot freed in the buffer
  assertEquals(drain(pointed, 5), [1, 2, 3, 4, 5]);

  // The stores passed in are left untouched
  assertEquals(before["queue"].buffer.entries[0].event.process.data?.size, 5);

  // Another comparator is registered under the key the store points to
  const registered = build();
  registered.disciplines = registerDiscipline(registered, {
    ...smallest,
    type: "policy",
  });
  registered.stores = reorderStore(registered, "queue");

  assertEquals(drain(registered, 5), [1, 2, 3, 4, 5]);
});

Deno.test("reorderStore reorders blocked consumers", () => {
  interface Bid extends StateData {
    bid?: number;
    lot?: string;
  }

  const sim = initializeSimulation();
  sim.stores = registerStore(sim, "lots", initializeStore({}));

  // Three consumers block in arrival order, each carrying its bid
  const requests = [10, 30, 20].map((bid) =>
    get(
      sim,
      createEvent<Bid>({
        scheduledAt: 0,
        process: { type: "none", data: { bid } },
      }),
      "lots",
    ).step
  );

  // Highest bid first from now on
  sim.disciplines = registerDiscipline<Bid>(sim, {
    type: "FIFO",
    comparator: (a, b) =>
      (b.event.process.data?.bid ?? 0) - (a.event.process.data?.bid ?? 0),
  });
  sim.stores = reorderStore(sim, "lots");

  const served = ["a", "b", "c"].map((lot) =>
    put(sim, createEvent({ scheduledAt: 0 }), "lots", { lot }).finish
  );

  assertEquals(served, [[requests[1]], [requests[2]], [requests[0]]]);
});

Deno.test("reorderStore throws on a missing store or discipline", () => {
  const sim = initializeSimulation();
  sim.stores = registerStore(
    sim,
    "queue",
    initializeStore({ discipline: { ...unregistered, type: "unknown" } }),
  );

  assertThrows(() => reorderStore(sim, "none"), RangeError, "Store not found");
  assertThrows(
    () => reorderStore(sim, "queue"),
    RangeError,
    "Discipline definition not found",
  );
});

Deno.test("cancel withdraws a blocked get: a later put no longer resumes it", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, "store", store);

  const consumerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const consumerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });
  const blockedA = get(sim, consumerA, "store");
  const blockedB = get(sim, consumerB, "store");
  assertEquals(blockedA.item, undefined);
  assertEquals(sim.stores["store"].getRequests.entries.length, 2);

  const result = cancel(sim, consumerA, "store", blockedA.step);

  assert(result);
  assert(!result.step.waiting);
  assertEquals(result.step.parent, consumerA.id);
  assertEquals(result.finish, [blockedA.step]);
  assertEquals(sim.stores["store"].getRequests.entries.length, 1);

  // The next item goes to the remaining consumer, not to the withdrawn one
  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "item" } },
  });
  const delivered = put(sim, producer, "store", {
    store: "store",
    foo: "item",
  });

  assertEquals(delivered.finish, [blockedB.step]);
  assertEquals(sim.stores["store"].getRequests.entries.length, 0);
});

Deno.test("cancel withdraws a blocked put: its item is never delivered", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);

  const producerA = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "A" } },
  });
  const producerB = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store", foo: "B" } },
  });
  const blockedA = put(sim, producerA, "store", { store: "store", foo: "A" });
  put(sim, producerB, "store", { store: "store", foo: "B" });

  const result = cancel(sim, producerA, "store", blockedA.step);

  assert(result);
  assertEquals(result.finish, [blockedA.step]);
  assertEquals(sim.stores["store"].putRequests.entries.length, 1);

  const consumer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store" } },
  });
  const received = get(sim, consumer, "store");

  assertEquals(received.step.process.data?.["foo"], "B");
});

Deno.test("cancel withdraws a blocked getWhere", () => {
  const sim = initializeSimulation();
  const store = initializeStore({ capacity: 1 });
  sim.stores = registerStore(sim, "store", store);
  const isBar: PredicateDefinition = {
    type: "isBar",
    predicate: (event) => event.process?.data?.["foo"] === "bar",
  };
  sim.predicates = registerPredicate(sim, isBar);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const blocked = getWhere(sim, consumer, "store", isBar);
  assertEquals(sim.stores["store"].getWhereRequests.length, 1);

  const result = cancel(sim, consumer, "store", blocked.step);

  assert(result);
  assertEquals(result.finish, [blocked.step]);
  assertEquals(sim.stores["store"].getWhereRequests.length, 0);

  // A matching item is now buffered instead of handed to the withdrawn consumer
  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "bar" } },
  });
  const buffered = put(sim, producer, "store", {
    store: "store",
    foo: "bar",
  });

  assertEquals(buffered.resume, undefined);
  assertEquals(sim.stores["store"].buffer.entries.length, 1);
});

Deno.test("cancel returns null when the request has already been served", () => {
  const sim = initializeSimulation();
  const store = initializeStore({});
  sim.stores = registerStore(sim, "store", store);

  const consumer = createEvent<FooData>({
    scheduledAt: 0,
    process: { type: "none", data: { store: "store" } },
  });
  const blocked = get(sim, consumer, "store");

  const producer = createEvent<FooData>({
    scheduledAt: 1,
    process: { type: "none", data: { store: "store", foo: "bar" } },
  });
  put(sim, producer, "store", { store: "store", foo: "bar" });

  const before = sim.stores["store"];

  assertEquals(cancel(sim, consumer, "store", blocked.step), null);
  assertEquals(sim.stores["store"], before);
});

Deno.test("waiting for an item or a timeout resumes the process once", async () => {
  interface WaitData extends StateData {
    why?: string;
    foo?: string;
    request?: Event;
    timeout?: Event;
  }

  // Runs one waiter that gives up at t=5, and a sender putting an item at `sendAt`
  // `fillers` events are handled in between: they move the point where the working state is compacted
  async function race(sendAt: number, fillers: number = 0) {
    const sim = initializeSimulation();
    const store = initializeStore({ capacity: 1 });
    sim.stores = registerStore(sim, "mailbox", store);
    const outcomes: string[] = [];

    const waiter: ProcessDefinition<
      {
        start: WaitData;
        stop: WaitData;
      },
      StoreItemMap,
      { stop: WaitData }
    > = {
      type: "waiter",
      initial: "start",
      steps: {
        start(sim, event, state) {
          const { step: request } = get(sim, event, "mailbox");
          const timeout = continueEvent<WaitData>(event, 5, { why: "timeout" });

          return {
            state: {
              ...state,
              step: "stop",
              data: { request, timeout },
            },
            next: [request, timeout],
          };
        },
        stop(sim, event, state) {
          const { request, timeout } = state.data;
          const { why, foo } = event.process.data;

          // Item arrived first: cancel the timeout
          if (why !== "timeout") {
            outcomes.push(`item ${foo}`);
            return { state, next: [], finish: [timeout!] };
          }

          // Timeout fired: withdraw the request from the store
          const withdrawn = cancel(sim, event, "mailbox", request!);

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
          const { resume, finish } = put(sim, event, "mailbox", { foo: "bar" });
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
    for (const _ of Array(fillers).keys()) {
      sim.timeline = scheduleEvent(sim, createEvent({ scheduledAt: 1 }));
    }

    const { result } = await runSimulation(sim);

    return {
      outcomes,
      store: result.stores["mailbox"],
      finished: result.timeline.transitions.filter((transition) =>
        transition.status === EventStatus.Finished
      ).map((transition) => transition.id),
    };
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

  // Same tie, with a compaction at each possible point: once between the timeout standing down and the item's continuation
  // The timeout, finished and dropped from the working state, is then left as is
  for (const fillers of Array(150).keys()) {
    const compacted = await race(5, fillers);
    assertEquals(compacted.outcomes, ["item bar"]);
    assertEquals(compacted.finished.length, new Set(compacted.finished).size);
  }
});

Deno.test("a blocked request that was not passed on is rejected when resumed", async () => {
  interface Parcel extends StateData {
    parcel?: string;
  }

  // A final step that puts, or gets, and drops `step`: only sound when the operation cannot block
  const sender: ProcessDefinition<{ send: Parcel }> = {
    type: "sender",
    initial: "send",
    steps: {
      send(sim, event, state) {
        const { resume, finish } = put(sim, event, "shelf", state.data);
        return { state, next: resume ?? [], finish };
      },
    },
  };
  const careless: ProcessDefinition<{ take: Parcel }> = {
    type: "careless",
    initial: "take",
    steps: {
      take(sim, event, state) {
        const { resume, finish } = get(sim, event, "shelf");
        return { state, next: resume ?? [], finish };
      },
    },
  };
  const taker: ProcessDefinition<{ take: Parcel; got: Parcel }> = {
    type: "taker",
    initial: "take",
    steps: {
      take(sim, event, state) {
        const { step, resume, finish } = get(sim, event, "shelf");
        return {
          state: { ...state, step: "got" },
          next: resume ? [step, ...resume] : [step],
          finish,
        };
      },
      got(_sim, _event, state) {
        return { state, next: [] };
      },
    },
  };

  // Processes started in order, one per time unit; `fillers` events in between move the compaction
  const build = (capacity: number, types: string[], fillers: number = 0) => {
    const sim = initializeSimulation();
    sim.stores = registerStore(sim, "shelf", initializeStore({ capacity }));
    sim.processes = registerProcess(sim, sender);
    sim.processes = registerProcess(sim, careless);
    sim.processes = registerProcess(sim, taker);
    for (const [at, type] of types.entries()) {
      sim.timeline = scheduleEvent(
        sim,
        createEvent({
          scheduledAt: 10 * at,
          process: { type, data: { parcel: `parcel ${at}` } },
        }),
      );
    }
    for (const _ of Array(fillers).keys()) {
      sim.timeline = scheduleEvent(sim, createEvent({ scheduledAt: 15 }));
    }
    return sim;
  };

  // The shelf has room for both parcels: nothing blocks, dropping `step` loses nothing
  const roomy = await runSimulation(
    build(2, ["sender", "sender", "taker", "taker"]),
  );
  assertEquals(roomy.result.stores["shelf"].buffer.entries.length, 0);

  // Room for one: the second sender blocks, and its dropped request is found out when a taker frees the slot
  await assertRejects(
    () => runSimulation(build(1, ["sender", "sender", "taker", "taker"])),
    RangeError,
    "Request not found in timeline",
  );

  // The same across a compaction
  await assertRejects(
    () => runSimulation(build(1, ["sender", "sender", "taker", "taker"], 150)),
    RangeError,
    "Request not found in timeline",
  );

  // A consumer that blocks and drops its request is found out by the next `put`
  await assertRejects(
    () => runSimulation(build(1, ["careless", "sender"])),
    RangeError,
    "Request not found in timeline",
  );

  // Operations made outside a run, on behalf of events the timeline does not hold, are left alone
  const outside = build(0, []);
  const blocked = put(outside, createEvent({ scheduledAt: 0 }), "shelf", {
    parcel: "seed",
  });
  const taken = get(outside, createEvent({ scheduledAt: 0 }), "shelf");
  assertEquals(taken.finish, [blocked.step]);
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

  // A simulation typed by its stores is written with them: the item type of each store is inferred
  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: { pool: initializeStore({ capacity: 1 }) },
  };
  put(sim, createEvent({ scheduledAt: 0 }), "pool", { tokenId: "T1" });

  const byJob: DisciplineDefinition<"byJob", Job> = {
    type: "byJob",
    comparator: (a, b) => a.seq - b.seq,
  };

  // Never called: only checks what the compiler rejects
  const _unsound = () => {
    // @ts-expect-error: `pool` is missing
    const _missing: Simulation<Stores> = { ...sim, stores: {} };
    const _added: Simulation<Stores> = {
      ...sim,
      // @ts-expect-error: `queue` is not a declared store
      stores: { pool: initializeStore({}), queue: initializeStore({}) },
    };
    const _ordered: Simulation<Stores> = {
      ...sim,
      // @ts-expect-error: a discipline over jobs, on a store of tokens
      stores: { pool: initializeStore({ discipline: byJob }) },
    };
    // A discipline over any item goes on any store
    const _any: Simulation<Stores> = {
      ...sim,
      stores: { pool: initializeStore({ discipline: unregistered }) },
    };
    // @ts-expect-error: `pool` holds tokens, not jobs
    put(sim, createEvent({ scheduledAt: 0 }), "pool", { jobId: 1 });
    // @ts-expect-error: a process over stores the simulation does not hold
    registerProcess(initializeSimulation(), job);
  };

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

  const overJobs: PredicateDefinition<Job> = {
    type: "overJobs",
    predicate: (item) => item.process.data?.jobId === 1,
  };
  const overTokens: PredicateDefinition<Token> = {
    type: "overTokens",
    predicate: (item) => item.process.data?.tokenId === "T1",
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
    // @ts-expect-error: a predicate over jobs, not tokens
    getWhere(sim, event, "pool", overJobs);
    getWhere(sim, event, "pool", overTokens);

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

  // The result of a run is typed by the stores it was started with
  const left: (string | undefined)[] = result.stores.pool.buffer.entries.map((
    { event },
  ) => event.process.data?.tokenId);
  assertEquals(left.length, 1);
  // @ts-expect-error: `queue` is not a declared store
  assertEquals(result.stores.queue, undefined);
});

Deno.test("a handler registers a store, and the history of the run keeps it", async () => {
  interface Mail extends StateData {
    to: string;
  }

  // One store is there from the start; the others are opened as residents move in
  type Stores = { lobby: Mail } & { [box: `box-${string}`]: Mail };

  const resident: ProcessDefinition<{ moveIn: Mail }, Stores> = {
    type: "resident",
    initial: "moveIn",
    steps: {
      moveIn(sim, event, state) {
        const box: `box-${string}` = `box-${state.data.to}`;
        sim.stores = registerStore(
          sim,
          box,
          initializeStore({ capacity: 2, consumerDiscipline: "LIFO" }),
        );

        // `step` is not passed on, the resident ends here: sound as the box has room
        const { resume, finish } = put(sim, event, box, state.data);

        return { state, next: resume ?? [], finish };
      },
    },
  };

  // Never called: only checks what the compiler rejects
  const _rejected: ProcessHandler<{ moveIn: Mail }, "moveIn", Stores> = (
    sim,
    _event,
    state,
  ) => {
    // @ts-expect-error: `cellar` is not a declared store
    registerStore(sim, "cellar", initializeStore({}));
    // @ts-expect-error: a store of something else than mail
    registerStore(sim, "box-Ada", initializeStore<{ parcel: number }>({}));

    return { state, next: [] };
  };

  const sim: Simulation<Stores> = {
    ...initializeSimulation(),
    stores: { lobby: initializeStore({}) },
  };
  sim.processes = registerProcess(sim, resident);
  sim.timeline = scheduleEvent(
    sim,
    createEvent({
      scheduledAt: 1,
      process: { type: resident, data: { to: "Ada" } },
    }),
  );

  const { result, history } = await runSimulation(sim, { history: {} });

  // `sim` is left untouched, the result holds the store with its item
  assertEquals(Object.keys(sim.stores), ["lobby"]);
  assertEquals(result.stores["box-Ada"].capacity, 2);
  assertEquals(result.stores["box-Ada"].consumerDiscipline, "LIFO");
  assertEquals(result.stores["box-Ada"].buffer.entries.length, 1);

  // So do the states rebuilt from the history: before the handler, without the store; after, with all of it
  const states = historyStates(history ?? []);
  assertEquals(Object.keys(states[0].stores), ["lobby"]);
  assertEquals(states.at(-1)?.stores, result.stores);

  // A state rebuilt from the history is typed by the stores of the run: a branch can register a process over them
  const replayed = states[states.length - 1];
  const branch = {
    ...replayed,
    processes: registerProcess(replayed, resident),
  };

  // The store works there
  const { item } = get(branch, createEvent({ scheduledAt: 1 }), "box-Ada");
  assertEquals(item?.to, "Ada");
});
