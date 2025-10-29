import {
  CreateStoreOptions,
  Event,
  EventState,
  Simulation,
  StateData,
  Store,
  StoreID,
} from "./model.ts";

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
): Event<T> {
  // Retrieve store
  // FIXME: Need a mapped type?
  const store = sim.stores[id] as Store<T>;
  if (!store) {
    throw RangeError(
      `Store not found: ${id}` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  // Check for pending get request
  // FIXME: getRequests is mutated in place
  const getRequest = store.getRequests.pop();
  if (getRequest) {
    // Reschedule the get request with the data attached
    const updatedGet: Event<T> = {
      ...getRequest,
      process: { ...getRequest.process, data },
      scheduledAt: sim.currentTime,
    };

    return updatedGet;
  }

  // No get request: handle based on blocking mode and remaining capacity
  if (
    store.blocking || (!store.blocking && store.buffer.length >= store.capacity)
  ) {
    // Blocking store: no buffer, only direct handoff or queue
    // Non-blocking store: no capacity, delay put request
    const updatedPut = { ...event, process: { ...event.process, data }, status: EventState.Waiting };
    const updatedStore = {
      ...store,
      putRequests: [...store.putRequests, updatedPut],
    };
    sim.stores = { ...sim.stores, [store.id]: updatedStore };
    return updatedPut;
  }

  // Non-blocking store: use buffer if capacity available
  const updatedPut = {
    ...event,
    process: { ...event.process, data },
    status: EventState.Scheduled,
    scheduledAt: sim.currentTime,
  };
  const updatedStore = {
    ...store,
    buffer: [...store.buffer, updatedPut],
  };
  sim.stores = { ...sim.stores, [store.id]: updatedStore };

  return updatedPut;
}

export function get<T extends StateData = StateData>(
  sim: Simulation,
  event: Event<T>,
  id: StoreID,
): Event<T> {
  // Retrieve store
  // FIXME: Need a mapped type?
  const store = sim.stores[id] as Store<T>;
  if (!store) {
    throw RangeError(
      `Store not found: ${id}` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  // Check buffer first for non-blocking stores (completed puts)
  if (!store.blocking && store.buffer.length > 0) {
    // Get data from buffer
    // FIXME: buffer is mutated in place
    const buffered = store.buffer.pop()!;

    // Return get event with the obtained data
    const updatedGet: Event<T> = {
      ...event,
      process: { ...event.process, data: buffered.process.data },
      scheduledAt: sim.currentTime,
      status: EventState.Scheduled,
    };

    return updatedGet;
  }

  // Check for pending put request (blocked producers)
  // FIXME: putRequests is mutated in place
  const putRequest = store.putRequests.pop();
  if (putRequest) {
    const updatedPut: Event<T> = {
      ...putRequest,
      scheduledAt: sim.currentTime,
    };

    return updatedPut;
  }

  // No data available: wait in queue
  const updatedGet = { ...event, status: EventState.Waiting };
  const updatedStore = {
    ...store,
    getRequests: [...store.getRequests, updatedGet],
  };
  sim.stores = { ...sim.stores, [store.id]: updatedStore };
  return updatedGet;
}
