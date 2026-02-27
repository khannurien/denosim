import {
  CreateStoreOptions,
  Event,
  ProcessRegistry,
  QueueDiscipline,
  Simulation,
  StateData,
  Store,
  StoreDefinitions,
  StoreID,
  StoreRegistry,
  StoreResult,
} from "./model.ts";
import { createEvent } from "./simulation.ts";

/**
 * Type guard that narrows a store event's `process.data` field from `StateData | undefined` to `T`.
 * Used internally before accessing payload data from resumed put requests or buffered items, where a missing payload indicates a programming error in the store usage.
 */
function hasStorePayload<T extends StateData>(
  payload: StateData | undefined,
): payload is T {
  return payload !== undefined;
}

/**
 * Creates a new store with:
 * - Unique ID
 * - Optional capacity (defaults to 1)
 * - Blocking or non-blocking behavior (defaults to `true`)
 * - A queueing discipline to follow (defaults to `QueueDiscipline.LIFO`)
 * All queues (`buffer`, `getRequests`, `putRequests`) start empty.
 * The returned store must be registered with `registerStore` before use in a simulation.
 */
export function initializeStore<
  T extends StateData = StateData,
  K extends StoreID = StoreID,
>(
  options: CreateStoreOptions,
): Store<T, K> {
  return {
    ...options,
    id: (options.id ?? crypto.randomUUID()) as K,
    capacity: options.capacity ?? 1,
    blocking: options.blocking ?? true,
    discipline: options.discipline ?? QueueDiscipline.LIFO,
    buffer: [],
    getRequests: [],
    putRequests: [],
  };
}

/**
 * Adds a store to the simulation's store registry and returns the updated store definitions.
 * The store's ID and payload type are reflected in the return type, enabling typed access via `sim.stores[id]` in subsequent calls.
 */
export function registerStore<
  R extends ProcessRegistry,
  S extends StoreRegistry,
  T extends StateData = StateData,
  K extends StoreID = StoreID,
>(
  sim: Simulation<R, S>,
  store: Store<T, K>,
): StoreDefinitions<S & Record<K, T>> {
  return {
    ...sim.stores,
    [store.id]: { ...store },
  } as StoreDefinitions<S & Record<K, T>>;
}

/**
 * Helper function to enqueue an event, returning the updated queue with the new event included.
 * Returns [existing events..., new event]
 */
function queuePut<T extends StateData = StateData>(
  queue: Event<T>[],
  item: Event<T>,
): Event<T>[] {
  return [...queue, item];
}

/**
 * Helper function to retrieve the next event from a queue based on the specified discipline, along with the updated queue with that event removed.
 * FIFO: [next event, remaining events...]
 * LIFO: [remaining events..., next event]
 */
function queueGet<T extends StateData = StateData>(
  discipline: QueueDiscipline,
  queue: Event<T>[],
): [Event<T>, Event<T>[]] {
  switch (discipline) {
    case QueueDiscipline.FIFO:
      return [queue[0], queue.slice(1)];
    case QueueDiscipline.LIFO:
      return [queue[queue.length - 1], queue.slice(0, -1)];
    default:
      throw new Error(`Unsupported queue discipline: ${discipline}`);
  }
}

/**
 * Sends `data` to a store on behalf of `event`. Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation. Three cases:
 * 1. Pending consumer (`getRequests` non-empty): the put completes immediately. The waiting consumer is dequeued and rescheduled with the data attached (`resume`); its waiting placeholder event is marked for cleanup (`finish`). The producer receives a continuation event (`step`).
 * 2. Blocking store, or non-blocking store at capacity (no pending consumer): the producer blocks. A waiting placeholder event carrying the data is created and added to `putRequests`. The same event is returned as `step` so the handler can schedule it.
 * 3. Non-blocking store with available capacity (no pending consumer): the data is buffered. A continuation event is added to the store's `buffer` and returned as `step`.
 */
export function put<
  R extends ProcessRegistry,
  S extends StoreRegistry,
  K extends keyof S & StoreID = keyof S & StoreID,
  T extends S[K] = S[K],
>(
  sim: Simulation<R, S>,
  event: Event<T>,
  id: K,
  data: T,
): StoreResult<T> {
  // Retrieve store
  const store = sim.stores[id];
  if (!store) {
    throw RangeError(
      `Store not found: ${id}` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  // Blocking store or non-blocking store at capacity: check for pending get request
  if (store.getRequests.length > 0) {
    const [getRequest, remaining] = queueGet(
      store.discipline,
      store.getRequests,
    );
    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        getRequests: remaining,
      },
    };

    // Reschedule the get request with the data attached
    const updatedGet: Event<T> = createEvent({
      parent: getRequest.parent,
      scheduledAt: sim.currentTime,
      process: {
        ...getRequest.process,
        inheritStep: true,
        data: { ...data },
      },
    });

    const updatedPut: Event<T> = createEvent({
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
      },
    });

    return { step: updatedPut, resume: [updatedGet], finish: [getRequest] };
  }

  // Blocking store or non-blocking store without pending get request: block put
  if (
    store.blocking || (!store.blocking && store.buffer.length >= store.capacity)
  ) {
    const updatedPut: Event<T> = createEvent({
      parent: event.id,
      waiting: true,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...data },
      },
    });

    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        putRequests: queuePut(store.putRequests, updatedPut),
      },
    };

    return { step: updatedPut };
  }

  // Non-blocking store with capacity available: use buffer
  const updatedPut: Event<T> = createEvent({
    parent: event.id,
    scheduledAt: sim.currentTime,
    process: {
      ...event.process,
      inheritStep: true,
      data: { ...data },
    },
  });

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      buffer: queuePut(store.buffer, updatedPut),
    },
  };

  return { step: updatedPut };
}

/**
 * Retrieves an item from a store on behalf of `event`. Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation. Three cases:
 * 1. Pending producer (`putRequests` non-empty): the get completes immediately. The waiting producer is dequeued and rescheduled (`resume`); its waiting placeholder event is marked for cleanup (`finish`). The consumer receives a continuation event (`step`) with the data attached.
 * 2. Non-blocking store with buffered data (`buffer` non-empty): the oldest (FIFO) or newest (LIFO) buffered item is dequeued and its data is attached to the consumer's continuation (`step`).
 * 3. No data available: the consumer blocks. A waiting placeholder event is created and added to `getRequests`. The same event is returned as `step` so the handler can schedule it.
 */
export function get<
  R extends ProcessRegistry,
  S extends StoreRegistry,
  K extends keyof S & StoreID = keyof S & StoreID,
  T extends S[K] = S[K],
>(
  sim: Simulation<R, S>,
  event: Event<T>,
  id: K,
): StoreResult<T> {
  // Retrieve store
  const store = sim.stores[id];
  if (!store) {
    throw RangeError(
      `Store not found: ${id}` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  // Check for pending put request (blocked producers)
  if (store.putRequests.length > 0) {
    const [putRequest, remaining] = queueGet(
      store.discipline,
      store.putRequests,
    );
    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        putRequests: remaining,
      },
    };

    const payload = putRequest.process.data;
    if (!hasStorePayload<T>(payload)) {
      throw TypeError(
        `Store payload is missing for resumed put request: ${id} ` +
          `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
      );
    }

    const updatedPut: Event<T> = createEvent({
      parent: putRequest.parent,
      scheduledAt: sim.currentTime,
      process: {
        ...putRequest.process,
        inheritStep: true,
        data: { ...payload },
      },
    });

    const updatedGet = createEvent({
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...payload },
      },
    });

    return { step: updatedGet, resume: [updatedPut], finish: [putRequest] };
  }

  // Non-blocking store: check buffer (completed puts)
  if (!store.blocking && store.buffer.length > 0) {
    // Get data from buffer
    const [buffered, remaining] = queueGet(store.discipline, store.buffer);
    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        buffer: remaining,
      },
    };

    // Return get request with the obtained data
    const payload = buffered.process.data;
    if (!hasStorePayload<T>(payload)) {
      throw TypeError(
        `Store payload is missing for buffered item: ${id} ` +
          `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
      );
    }

    const updatedGet = createEvent({
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...payload },
      },
    });

    return { step: updatedGet };
  }

  // No data available: wait in queue
  const updatedGet = createEvent({
    parent: event.id,
    scheduledAt: sim.currentTime,
    waiting: true,
    process: { ...event.process, inheritStep: true },
  });

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      getRequests: queuePut(store.getRequests, updatedGet),
    },
  };

  return { step: updatedGet };
}
