import {
  CreateStoreOptions,
  Event,
  ProcessRegistry,
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
  options: CreateStoreOptions<T> & { id?: K },
): Store<T, K> {
  return {
    ...options,
    id: (options.id ?? crypto.randomUUID()) as K,
    blocking: options.blocking ?? true,
    capacity: options.capacity ?? 1,
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
    const getRequest = store.getRequests[store.getRequests.length - 1]!;
    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        getRequests: store.getRequests.slice(0, -1),
      },
    };

    // Reschedule the get request with the data attached
    const updatedGet: Event<T> = createEvent<T>(sim, {
      parent: getRequest.parent,
      scheduledAt: sim.currentTime,
      process: {
        ...getRequest.process,
        inheritStep: true,
        data: { ...data },
      },
    });

    const updatedPut: Event<T> = createEvent(sim, {
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
      },
    });

    return { step: updatedPut, resume: updatedGet };
  }

  // // Blocking store or non-blocking store without pending get request: block put
  if (
    store.blocking || (!store.blocking && store.buffer.length >= store.capacity)
  ) {
    const updatedPut: Event<T> = createEvent(sim, {
      parent: event.id,
      waiting: true,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...data },
      },
    });

    const updatedStore = {
      ...store,
      putRequests: [...store.putRequests, updatedPut],
    };
    sim.stores = { ...sim.stores, [store.id]: updatedStore };

    return { step: updatedPut };
  }

  // Non-blocking store with capacity available: use buffer
  const updatedPut: Event<T> = createEvent(sim, {
    parent: event.id,
    scheduledAt: sim.currentTime,
    process: {
      ...event.process,
      inheritStep: true,
      data: { ...data },
    },
  });

  const updatedStore = {
    ...store,
    buffer: [...store.buffer, updatedPut],
  };

  sim.stores = { ...sim.stores, [store.id]: updatedStore };

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
    const putRequest = store.putRequests[store.putRequests.length - 1]!;
    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        putRequests: store.putRequests.slice(0, -1),
      },
    };

    const payload = putRequest.process.data;
    if (!hasStorePayload<T>(payload)) {
      throw TypeError(
        `Store payload is missing for resumed put request: ${id} ` +
          `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
      );
    }

    const updatedPut: Event<T> = createEvent<T>(sim, {
      parent: putRequest.parent,
      scheduledAt: sim.currentTime,
      process: {
        ...putRequest.process,
        inheritStep: true,
        data: { ...payload },
      },
    });

    const updatedGet = createEvent<T>(sim, {
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...payload },
      },
    });

    return { step: updatedGet, resume: updatedPut };
  }

  // Non-blocking store: check buffer (completed puts)
  if (!store.blocking && store.buffer.length > 0) {
    // Get data from buffer
    const buffered = store.buffer[store.buffer.length - 1]!;
    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        buffer: store.buffer.slice(0, -1),
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

    const updatedGet = createEvent<T>(sim, {
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
  const updatedGet = createEvent(sim, {
    parent: event.id,
    scheduledAt: sim.currentTime,
    waiting: true,
    process: { ...event.process, inheritStep: true },
  });

  const updatedStore = {
    ...store,
    getRequests: [...store.getRequests, updatedGet],
  };

  sim.stores = { ...sim.stores, [store.id]: updatedStore };

  return { step: updatedGet };
}
