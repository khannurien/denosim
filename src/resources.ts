import { Event, ProcessStep, Simulation, Store } from "./model.ts";

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
  _sim: Simulation,
  event: Event<T>,
  store: Store<T>,
): ProcessStep<T> {
  while (true) {
    // Return the item immediately if it has already been fetched into the request
    if (event.item) {
      return event.item;
    }

    // If a put request has already been fired, pop it from the queue
    // Return the item immediately
    if (store.putRequests.length > 0) {
      const putRequest = store.putRequests.sort((a, b) =>
        b.scheduledAt - a.scheduledAt
      ).pop();

      return putRequest?.item;
    }

    // If there is no item available, emit a get request
    store.getRequests = [...store.getRequests, event];

    // Yield continuation
    yield;
  }
}

/**
 * Non-blocking operation that puts an item in a store.
 * If there are pending get requests, handles the earliest one with said item.
 * Otherwise, stores the item in a put request for future use.
 */
export function* put<T>(
  sim: Simulation,
  event: Event<T>,
  store: Store<T>,
  item: T,
): ProcessStep<T> {
  // Sort get requests in descending order so we can efficiently pop the earliest one
  const getRequest = store.getRequests.sort((a, b) =>
    b.scheduledAt - a.scheduledAt
  ).pop();

  // FIXME: Immutable version, not working
  // Either create a new put request or handle an existing get request
  // const done = (!getRequest) ? { ...event, item } : {
  //   ...getRequest,
  //   scheduledAt: sim.currentTime,
  //   item,
  // };
  // if (!getRequest) {
  //   // There was no pending get request, store the put request
  //   store.putRequests = [done, ...store.putRequests];
  // }

  // FIXME: Mutable version, working
  const done = (!getRequest) ? { ...event, item } : getRequest;
  if (!getRequest) {
    // There was no pending get request, store the put request
    store.putRequests = [done, ...store.putRequests];
  } else {
    // Store the item in the get request
    getRequest.item = item;
    // Re-schedule it for process continuation
    getRequest.scheduledAt = sim.currentTime;
  }

  // Yield continuation
  yield done;
}
