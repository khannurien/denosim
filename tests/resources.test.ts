import { assertEquals, assertThrows } from "@std/assert";
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

  const store = initializeStore<FooData>({});
  sim.stores = registerStore(sim, store);

  const prod: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "prod",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = put(sim, event, store.id, {
          ...state.data,
        });

        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };

        return {
          updated: nextEvent,
          state: { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(_sim, event, state) {
        return {
          updated: event,
          state,
          next: [],
        };
      },
    },
  };

  const cons: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "cons",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = get(sim, event, store.id);

        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };

        return {
          updated: nextEvent,
          state: request.id !== event.id
            ? {
              ...state,
              data: request.process.data
                ? { ...request.process.data }
                : state.data,
              step: "stop",
            }
            : { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(_sim, event, state) {
        return {
          updated: event,
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, prod);
  sim.registry = registerProcess(sim, cons);

  // Test scenario: producer first, then consumer
  const e1 = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "prod",
      data: { foo: "bar" },
    },
  });
  sim.events = scheduleEvent(sim, e1);

  const e2 = createEvent(sim, {
    scheduledAt: 1,
    process: { type: "cons" },
  });
  sim.events = scheduleEvent(sim, e2);

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // Verify both processes completed
  assertEquals(finalState.state[e1.id]?.step, "stop");
  assertEquals(finalState.state[e2.id]?.step, "stop");

  // Verify consumer received the data
  assertEquals(finalState.state[e2.id]?.data.foo, "bar");

  // Verify store is empty (all requests processed)
  assertEquals(finalState.stores[store.id].getRequests.length, 0);
  assertEquals(finalState.stores[store.id].putRequests.length, 0);
});

Deno.test("multiple consumers with single producer", async () => {
  const sim = initializeSimulation();

  const store = initializeStore<FooData>({});
  sim.stores = registerStore(sim, store);

  const prod: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "prod",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = put(sim, event, store.id, { ...state.data });
        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };
        return {
          updated: nextEvent,
          state: { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  const cons: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "cons",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = get(sim, event, store.id);
        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };
        return {
          updated: nextEvent,
          state: request.id !== event.id
            ? {
              ...state,
              data: request.process.data
                ? { ...request.process.data }
                : state.data,
              step: "stop",
            }
            : { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  sim.registry = registerProcess(sim, prod);
  sim.registry = registerProcess(sim, cons);

  // Setup: one producer, two consumers
  const producer1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "prod", data: { foo: "bar" } },
  });
  const consumer1 = createEvent(sim, {
    scheduledAt: 1,
    process: { type: "cons" },
  });
  const consumer2 = createEvent(sim, {
    scheduledAt: 5,
    process: { type: "cons" },
  });

  sim.events = scheduleEvent(sim, producer1);
  sim.events = scheduleEvent(sim, consumer1);
  sim.events = scheduleEvent(sim, consumer2);

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // First consumer should get data
  assertEquals(finalState.state[consumer1.id]?.data.foo, "bar");
  // Second consumer should be blocked (no data)
  assertEquals(finalState.state[consumer2.id]?.data.foo, undefined);
  // Second consumer should still be waiting in store
  assertEquals(finalState.stores[store.id].getRequests.length, 1);
});

Deno.test("multiple producers with delayed consumers", async () => {
  const sim = initializeSimulation();

  const store = initializeStore<FooData>({});
  sim.stores = registerStore(sim, store);

  const prod: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "prod",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = put(sim, event, store.id, { ...state.data });
        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };
        return {
          updated: nextEvent,
          state: { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  const cons: ProcessDefinition<{
    start: [FooData, [FooData] | []];
    stop: [FooData, []];
  }> = {
    type: "cons",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = get(sim, event, store.id);
        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };
        return {
          updated: nextEvent,
          state: request.id !== event.id
            ? {
              ...state,
              data: request.process.data
                ? { ...request.process.data }
                : state.data,
              step: "stop",
            }
            : { ...state, step: "stop" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      stop(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  sim.registry = registerProcess(sim, prod);
  sim.registry = registerProcess(sim, cons);

  // Setup: consumers first, then producers
  const consumer1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "cons" },
  });
  const producer1 = createEvent(sim, {
    scheduledAt: 5,
    process: { type: "prod", data: { foo: "first" } },
  });
  const producer2 = createEvent(sim, {
    scheduledAt: 10,
    process: { type: "prod", data: { foo: "second" } },
  });

  sim.events = scheduleEvent(sim, consumer1);
  sim.events = scheduleEvent(sim, producer1);
  sim.events = scheduleEvent(sim, producer2);

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // Consumer should get the first available data
  assertEquals(finalState.state[consumer1.id]?.data.foo, "first");
  // Second producer should be blocked (no consumer)
  assertEquals(finalState.stores[store.id].putRequests.length, 1);
});

Deno.test("non-blocking store with capacity > 1", async () => {
  const sim = initializeSimulation();

  // Non-blocking store with capacity for 2 items
  const store = initializeStore<NumberData>({
    blocking: false,
    capacity: 2,
  });
  sim.stores = registerStore(sim, store);

  const producer: ProcessDefinition<{
    produce: [NumberData, [NumberData]];
    done: [NumberData, []];
  }> = {
    type: "producer",
    initial: "produce",
    steps: {
      produce(sim, event, state) {
        const request = put(sim, event, store.id, { value: state.data.value });
        return {
          updated: { ...event, scheduledAt: sim.currentTime },
          state: { ...state, step: "done" },
          next: [request],
        };
      },
      done(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  sim.registry = registerProcess(sim, producer);

  // Schedule multiple producers - should all succeed immediately with non-blocking store
  const producer1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "producer", data: { value: 1 } },
  });
  const producer2 = createEvent(sim, {
    scheduledAt: 1,
    process: { type: "producer", data: { value: 2 } },
  });
  const producer3 = createEvent(sim, {
    scheduledAt: 2,
    process: { type: "producer", data: { value: 3 } },
  });

  sim.events = scheduleEvent(sim, producer1);
  sim.events = scheduleEvent(sim, producer2);
  sim.events = scheduleEvent(sim, producer3);

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // First two should be in buffer (capacity 2)
  assertEquals(finalState.stores[store.id].buffer.length, 2);
  // Third should be in putRequests (exceeded capacity)
  assertEquals(finalState.stores[store.id].putRequests.length, 1);
  // Verify the values in buffer
  const bufferValues = finalState.stores[store.id].buffer.map((e) =>
    e.process.data?.value
  );
  assertEquals(bufferValues.sort(), [1, 2]);
});

Deno.test("blocking store with unlimited capacity behavior", async () => {
  const sim = initializeSimulation();

  // Blocking store with default capacity (1)
  const store = initializeStore<FooData>({
    blocking: true,
    capacity: 1, // Explicitly set to default for clarity
  });
  sim.stores = registerStore(sim, store);

  const producer: ProcessDefinition<{
    produce: [FooData, [FooData] | []];
    done: [FooData, []];
  }> = {
    type: "producer",
    initial: "produce",
    steps: {
      produce(sim, event, state) {
        const request = put(sim, event, store.id, {
          foo: `item-${state.data.foo}`,
        });
        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };
        return {
          updated: nextEvent,
          state: { ...state, step: "done" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      done(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  const consumer: ProcessDefinition<{
    consume: [FooData, [FooData] | []];
    done: [FooData, []];
  }> = {
    type: "consumer",
    initial: "consume",
    steps: {
      consume(sim, event, state) {
        const request = get(sim, event, store.id);
        const nextEvent = {
          ...event,
          scheduledAt: sim.currentTime,
          status: request.id !== event.id
            ? EventState.Scheduled
            : EventState.Waiting,
        };
        return {
          updated: nextEvent,
          state: request.id !== event.id
            ? {
              ...state,
              data: request.process.data
                ? { ...request.process.data }
                : state.data,
              step: "done",
            }
            : { ...state, step: "done" },
          next: request.id !== event.id ? [request] : [],
        };
      },
      done(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  sim.registry = registerProcess(sim, producer);
  sim.registry = registerProcess(sim, consumer);

  // Producer first, then delayed consumer
  const producer1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "producer", data: { foo: "A" } },
  });
  const consumer1 = createEvent(sim, {
    scheduledAt: 5,
    process: { type: "consumer" },
  });

  sim.events = scheduleEvent(sim, producer1);
  sim.events = scheduleEvent(sim, consumer1);

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // Producer should be blocked until consumer arrives
  assertEquals(finalState.state[producer1.id]?.step, "done");
  assertEquals(finalState.state[consumer1.id]?.step, "done");
  assertEquals(finalState.state[consumer1.id]?.data.foo, "item-A");
  // Store should be empty after handoff
  assertEquals(finalState.stores[store.id].buffer.length, 0);
  assertEquals(finalState.stores[store.id].putRequests.length, 0);
  assertEquals(finalState.stores[store.id].getRequests.length, 0);
});

Deno.test("non-blocking store with capacity 0 (immediate rejection)", async () => {
  const sim = initializeSimulation();

  // Non-blocking store with zero capacity - should always reject puts
  const store = initializeStore<NumberData>({
    blocking: false,
    capacity: 0,
  });
  sim.stores = registerStore(sim, store);

  const producer: ProcessDefinition<{
    tryProduce: [NumberData, [NumberData]];
    done: [NumberData, []];
  }> = {
    type: "producer",
    initial: "tryProduce",
    steps: {
      tryProduce(sim, event, state) {
        const request = put(sim, event, store.id, { value: state.data.value });
        // With capacity 0 and non-blocking, should always go to putRequests
        return {
          updated: { ...event, scheduledAt: sim.currentTime },
          state: { ...state, step: "done" },
          next: [request],
        };
      },
      done(_sim, event, state) {
        return { updated: event, state, next: [] };
      },
    },
  };

  sim.registry = registerProcess(sim, producer);

  const producer1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "producer", data: { value: 42 } },
  });
  sim.events = scheduleEvent(sim, producer1);

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // Should be in putRequests since capacity is 0
  assertEquals(finalState.stores[store.id].buffer.length, 0);
  assertEquals(finalState.stores[store.id].putRequests.length, 1);
  assertEquals(
    finalState.stores[store.id].putRequests[0].process.data?.value,
    42,
  );
});

Deno.test("non-blocking store LIFO behavior", () => {
  const sim = initializeSimulation();

  const store = initializeStore<NumberData>({
    blocking: false,
    capacity: 5,
  });
  sim.stores = registerStore(sim, store);

  // Test that buffer uses LIFO (stack) behavior
  const testEvent = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "none" },
  });

  // Put values in order
  put(sim, testEvent, store.id, { value: 1 });
  put(sim, testEvent, store.id, { value: 2 });
  put(sim, testEvent, store.id, { value: 3 });

  // Get should retrieve in reverse order (LIFO)
  const get1 = get(sim, testEvent, store.id);
  const get2 = get(sim, testEvent, store.id);
  const get3 = get(sim, testEvent, store.id);

  assertEquals(get1.process.data?.value, 3); // Last in, first out
  assertEquals(get2.process.data?.value, 2);
  assertEquals(get3.process.data?.value, 1);
});

Deno.test("non-blocking store basic put/get operations", () => {
  const sim = initializeSimulation();

  const store = initializeStore<NumberData>({
    blocking: false,
    capacity: 3,
  });
  sim.stores = registerStore(sim, store);

  // Test direct put operations
  const event1 = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "none" },
  });

  const putResult1 = put(sim, event1, store.id, { value: 1 });
  const putResult2 = put(sim, event1, store.id, { value: 2 });
  const putResult3 = put(sim, event1, store.id, { value: 3 });
  const putResult4 = put(sim, event1, store.id, { value: 4 }); // Should exceed capacity

  // First 3 should be Scheduled (in buffer), 4th should be Waiting (in putRequests)
  assertEquals(putResult1.status, EventState.Scheduled);
  assertEquals(putResult2.status, EventState.Scheduled);
  assertEquals(putResult3.status, EventState.Scheduled);
  assertEquals(putResult4.status, EventState.Waiting);

  // Test get operations
  const getResult1 = get(sim, event1, store.id);
  const getResult2 = get(sim, event1, store.id);
  const getResult3 = get(sim, event1, store.id);
  const getResult4 = get(sim, event1, store.id); // Should be Waiting (no data)

  // First 3 gets should get data, 4th should wait
  assertEquals(getResult1.status, EventState.Scheduled);
  assertEquals(getResult2.status, EventState.Scheduled);
  assertEquals(getResult3.status, EventState.Scheduled);
  assertEquals(getResult4.status, EventState.Waiting);
});

Deno.test("mixed blocking/non-blocking operations with high capacity", async () => {
  const sim = initializeSimulation();

  // Large capacity non-blocking store
  const store = initializeStore<NumberData>({
    blocking: false,
    capacity: 10,
  });
  sim.stores = registerStore(sim, store);

  // Simple producer that just puts data
  const producer: ProcessDefinition<{
    start: [NumberData, []];
  }> = {
    type: "producer",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const _request = put(sim, event, store.id, { value: state.data.value });

        // For non-blocking store with capacity, put should always succeed immediately
        return {
          updated: {
            ...event,
            status: EventState.Finished,
            finishedAt: sim.currentTime,
          },
          state: { ...state, step: "start" },
          next: [],
        };
      },
    },
  };

  // Simple consumer that just gets data
  const consumer: ProcessDefinition<{
    start: [NumberData, []];
  }> = {
    type: "consumer",
    initial: "start",
    steps: {
      start(sim, event, state) {
        const request = get(sim, event, store.id);

        return {
          updated: {
            ...event,
            status: EventState.Finished,
            finishedAt: sim.currentTime,
          },
          state: {
            ...state,
            data: request.process.data
              ? { ...request.process.data }
              : state.data,
            step: "start",
          },
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, producer);
  sim.registry = registerProcess(sim, consumer);

  // Create producers first
  const producers = Array.from({ length: 8 }, (_, i) =>
    createEvent(sim, {
      scheduledAt: i,
      process: { type: "producer", data: { value: i } },
    }));

  // Create consumers later
  const consumers = Array.from({ length: 5 }, (_, i) =>
    createEvent(sim, {
      scheduledAt: i + 10, // Start after all producers
      process: { type: "consumer" },
    }));

  producers.forEach((p) => sim.events = scheduleEvent(sim, p));
  consumers.forEach((c) => sim.events = scheduleEvent(sim, c));

  const [states, _stats] = await runSimulation(sim);
  const finalState = states[states.length - 1];

  // With LIFO behavior, consumers get the most recent items (7,6,5,4,3)
  // and the oldest items (0,1,2) remain in buffer
  assertEquals(finalState.stores[store.id].buffer.length, 3);
  assertEquals(finalState.stores[store.id].putRequests.length, 0);
  assertEquals(finalState.stores[store.id].getRequests.length, 0);

  // Verify consumers got the expected LIFO values
  const consumerValues = consumers.map((c) =>
    finalState.state[c.id]?.data?.value
  )
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);

  assertEquals(consumerValues, [3, 4, 5, 6, 7]);

  // Verify buffer contains the oldest values
  const bufferValues = finalState.stores[store.id].buffer.map((e) =>
    e.process.data?.value
  )
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);

  assertEquals(bufferValues, [0, 1, 2]);
});

Deno.test("non-blocking store LIFO behavior", () => {
  const sim = initializeSimulation();

  const store = initializeStore<NumberData>({
    blocking: false,
    capacity: 5,
  });
  sim.stores = registerStore(sim, store);

  // Test that buffer uses LIFO (stack) behavior
  const testEvent = createEvent(sim, {
    scheduledAt: 0,
    process: { type: "none" },
  });

  // Put values in order
  const _put1 = put(sim, testEvent, store.id, { value: 1 });
  const _put2 = put(sim, testEvent, store.id, { value: 2 });
  const _put3 = put(sim, testEvent, store.id, { value: 3 });

  // Get should retrieve in reverse order (LIFO)
  const get1 = get(sim, testEvent, store.id);
  const get2 = get(sim, testEvent, store.id);
  const get3 = get(sim, testEvent, store.id);

  assertEquals(get1.process.data?.value, 3); // Last in, first out
  assertEquals(get2.process.data?.value, 2);
  assertEquals(get3.process.data?.value, 1);
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
    process: { type: "none" },
  });

  // Should throw when trying to access non-existent store
  assertThrows(
    () => get(sim, event, "non-existent-store-id"),
    RangeError,
    "Store not found",
  );

  assertThrows(
    () => put(sim, event, "another-fake-store", { test: "data" }),
    RangeError,
    "Store not found",
  );
});
