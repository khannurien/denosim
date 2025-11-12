import {
  CreateStoreOptions,
  Event,
  Simulation,
  StateData,
  Store,
  StoreID,
  StoreResult,
} from "./model.ts";
import { createEvent } from "./simulation.ts";

export function initializeStore<T extends StateData = StateData>(
  options: CreateStoreOptions<T>,
): Store<T> {
  return {
    ...options,
    id: crypto.randomUUID(),
    blocking: options.blocking ?? true,
    capacity: options.capacity ?? 1,
    buffer: [],
    getRequests: [],
    putRequests: [],
  };
}

export function registerStore<T extends StateData = StateData>(
  sim: Simulation,
  store: Store<T>,
): Record<StoreID, Store> {
  return { ...sim.stores, [store.id]: { ...store } };
}

export function put<T extends StateData = StateData>(
  sim: Simulation,
  event: Event<T>,
  id: StoreID,
  data: T,
): StoreResult<T> {
  // Retrieve store
  // FIXME: Explicit cast. Need a mapped type?
  const store = sim.stores[id] as Store<T>;
  if (!store) {
    throw RangeError(
      `Store not found: ${id}` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  // Blocking store or non-blocking store at capacity: check for pending get request
  if (store.getRequests.length > 0) {
    const getRequest = store.getRequests.pop()!;

    // Reschedule the get request with the data attached
    const updatedGet: Event<T> = createEvent(sim, {
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
    },
  });

  const updatedStore = {
    ...store,
    buffer: [...store.buffer, updatedPut],
  };

  sim.stores = { ...sim.stores, [store.id]: updatedStore };

  return { step: updatedPut };
}

export function get<T extends StateData = StateData>(
  sim: Simulation,
  event: Event<T>,
  id: StoreID,
): StoreResult<T> {
  // Retrieve store
  // FIXME: Explicit cast. Need a mapped type?
  const store = sim.stores[id] as Store<T>;
  if (!store) {
    throw RangeError(
      `Store not found: ${id}` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  // Check for pending put request (blocked producers)
  if (store.putRequests.length > 0) {
    const putRequest = store.putRequests.pop()!;

    const updatedPut: Event<T> = createEvent(sim, {
      parent: putRequest.parent,
      scheduledAt: sim.currentTime,
      process: { ...putRequest.process, inheritStep: true },
    });

    // FIXME: Explicit cast
    const updatedGet = createEvent(sim, {
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...updatedPut.process.data },
      },
    }) as Event<T>;

    return { step: updatedGet, resume: updatedPut };
  }

  // Non-blocking store: check buffer (completed puts)
  if (!store.blocking && store.buffer.length > 0) {
    // Get data from buffer
    const buffered = store.buffer.pop()!;

    // Return get request with the obtained data
    // FIXME: Explicit cast
    const updatedGet = createEvent(sim, {
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...buffered.process.data },
      },
    }) as Event<T>;

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
