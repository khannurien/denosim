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

function hasStorePayload<T extends StateData>(
  payload: StateData | undefined,
): payload is T {
  return payload !== undefined;
}

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
