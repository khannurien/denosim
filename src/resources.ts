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
    capacity: options.capacity ?? 1,
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
  // if (store.putRequests.length >= store.capacity ...

  // Check for pending get request
  // FIXME: getRequests is mutated in place
  const request = store.getRequests.pop();
  if (!request) {
    const updated = { ...event, status: EventState.Waiting, ...data };
    // No request: save the put request to the store and return it
    const updatedStore = {
      ...store,
      putRequests: [...store.putRequests, updated],
    };
    sim.stores = { ...sim.stores, [store.id]: updatedStore };
    return updated;
  }

  // TODO: Reschedule the get request with the data attached
  const updatedRequest = {
    ...request,
    ...data,
    status: EventState.Scheduled,
    scheduledAt: sim.currentTime,
  };

  return updatedRequest;
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

  // Check for pending put request
  // FIXME: getRequests is mutated in place
  const request = store.putRequests.pop();
  if (!request) {
    const updated = { ...event, status: EventState.Waiting };
    // No request: save the get request to the store and return it
    const updatedStore = {
      ...store,
      getRequests: [...store.getRequests, updated],
    };
    sim.stores = { ...sim.stores, [store.id]: updatedStore };
    return updated;
  }

  // TODO: Reschedule the put request
  const updatedRequest = {
    ...request,
    status: EventState.Scheduled,
    scheduledAt: sim.currentTime,
  };

  return updatedRequest;
}
