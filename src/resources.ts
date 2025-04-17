import { Event, ProcessState, Simulation, Store } from "./model.ts";

/**
 * Creates a new store with:
 * - Unique ID
 * - Array of initial items (defaults to an empty array)
 * - Empty requests array (no scheduled get requests)
 */
export function createStore<T>(): Store<T> {
  return {
    getRequests: [],
    putRequests: [],
  };
}

/**
 * Blocking operations that gets an item from a store.
 * Pops an item from the store if available, returning it immediately.
 * If there is no item in store, yields control and resumes on the next put operation.
 * Returns the item that has been put into the request.
 */
export function* get<T>(
  sim: Simulation,
  event: Event<T>,
  store: Store<T>,
): ProcessState<T> {
  while (true) {
    // If a put request has been fired, pop it from the queue
    const putRequest = store.putRequests.sort((a, b) =>
      b.scheduledAt - a.scheduledAt
    ).pop();

    if (putRequest) {
      // Return the completed request immediately
      return [sim, putRequest];
    }

    // If there is no item available, emit a get request
    store.getRequests = [...store.getRequests, event];

    // Yield control
    return yield;
  }
}

/**
 * Non-blocking operation that puts an item in a store.
 * FIXME: The operation can be configured to be blocking.
 * If there are pending get requests, handles the earliest one with said item.
 * Otherwise, stores the item in a put request for future use.
 */
export function* put<T>(
  sim: Simulation,
  event: Event<T>,
  store: Store<T>,
  item: T,
): ProcessState<T> {
  // Sort get requests in descending order so we can efficiently pop the earliest one
  const getRequest = store.getRequests.sort((a, b) =>
    b.scheduledAt - a.scheduledAt
  ).pop();

  // Either create a new put request or handle an existing get request
  const putRequest = (!getRequest) ? { ...event, item } : {
    ...getRequest,
    scheduledAt: sim.currentTime,
    item,
  };

  if (!getRequest) {
    // There was no pending get request, store the put request
    store.putRequests = [putRequest, ...store.putRequests];
  }

  // Yield continuation
  return yield putRequest;
}
