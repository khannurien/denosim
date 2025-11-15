import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createEvent,
  get,
  initializeSimulation,
  initializeStore,
  ProcessDefinition,
  put,
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

Deno.test.beforeEach(() => {
});

Deno.test("producer-consumer synchronization with blocking", async () => {
  const sim = initializeSimulation();

  const store = initializeStore({});

  sim.stores = registerStore(sim, store);

  sim.registry = registerProcess(sim, prod);
  sim.registry = registerProcess(sim, cons);

  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "prod", data: { store: store.id, foo: "bar" } },
  });

  const e2 = createEvent(sim, {
    scheduledAt: 5,
    process: { type: "cons", data: { store: store.id} },
  })

  const e3 = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "cons", data: { store: store.id} },
  })

  const e4 = createEvent(sim, {
    scheduledAt: 15,
    process: { type: "prod", data: { store: store.id, foo: "baz" } },
  });

  sim.events = scheduleEvent(sim, e1);
  sim.events = scheduleEvent(sim, e2);
  sim.events = scheduleEvent(sim, e3);
  sim.events = scheduleEvent(sim, e4);

  const [states, _stats] = await runSimulation(sim);
  const stop = states[states.length - 1];

  // Consumer has been unblocked by consumer
  const prodBlocked = stop.events.find((event) => event.id === e1.id);
  assertEquals(prodBlocked?.finishedAt, 0);
  const prodUnblocked = stop.events.find((event) => event.parent && event.parent === e1.id);
  assertEquals(prodUnblocked?.finishedAt, 5);

  // Consumer has been unblocked by producer and has gotten the data
  const consBlocked = stop.events.find((event) => event.id === e3.id);
  assertEquals(consBlocked?.finishedAt, 10);
  const consUnblocked = stop.events.find((event) => event.parent && event.parent === e3.id);
  assertEquals(consUnblocked?.finishedAt, 15);
  assertEquals(consUnblocked!.process.data!["foo"], "baz");

  // All processes have reached their final step
  assert(Object.values(stop.state).every(state => state.step === "stop"));
});

Deno.test("multiple consumers with single producer", async () => {
});

Deno.test("multiple producers with delayed consumers", async () => {
});

Deno.test("non-blocking store with capacity > 1", async () => {
});

Deno.test("blocking store with unlimited capacity behavior", async () => {
});

Deno.test("non-blocking store with capacity 0 (immediate rejection)", async () => {
});

Deno.test("non-blocking store LIFO behavior", () => {
});

Deno.test("non-blocking store basic put/get operations", () => {
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
  const event = createEvent(sim, {
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
