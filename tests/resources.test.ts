import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createEvent,
  EventState,
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
} from "../mod.ts";

interface FooData extends StateData {
  "foo": string;
}

interface NumberData extends StateData {
  "value": number;
}

Deno.test("producer-consumer synchronization with blocking", async () => {
  const sim = initializeSimulation();

  const store = initializeStore(
    {
      blocking: true,
    },
  );

  sim.stores = registerStore(sim, store);

  const foo: ProcessDefinition<{
    bar: [FooData, []];
  }> = {
    type: "foo",
    initial: "bar",
    steps: {
      bar(sim, event, state) {
        const { step, resume } = put(sim, event, store.id, {
          ...state.data,
        });

        return {
          state: { ...state, step: "bar" },
          next: [],
        };
      },
    }
  }

  sim.registry = registerProcess(sim, foo);

  const e1 = createEvent(sim, { scheduledAt: sim.currentTime, process: { type: "foo" } });

  sim.events = scheduleEvent(sim, e1);

  const [states, _stats] = await runSimulation(sim);
  const stop = states[states.length - 1];
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

Deno.test("mixed blocking/non-blocking operations with high capacity", async () => {
});

Deno.test("non-blocking store LIFO behavior", () => {
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
