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
 * Gets an item from a store.
 * Pops an item from the store if available, returning it immediately.
 * If there is no item in store, yields control and resumes on the next put operation.
 * Returns the item that has been put into the request.
 */
export function* get<T>(
  sim: Simulation,
  event: Event<T>,
  store: Store<T>,
): ProcessStep<T> {
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

  // Update the event with the item if it exists
  // Emit a get request for when an item will be made available in the store
  const getRequest: Event<T> = {
    ...event,
    firedAt: sim.currentTime,
    scheduledAt: sim.currentTime,
  };

  // If there is no item available, emit a get request
  store.getRequests = [...store.getRequests, getRequest];

  // Yield continuation
  yield getRequest;
}

/**
 * Puts an item in a store.
 * If there are pending get requests, handles the earliest one with said item.
 * Otherwise, stores the item for future requests.
 * Yields control immediately.
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

  // Either create a new put request or handle an existing get request
  const done = (!getRequest) ? { ...event, item } : {
    ...getRequest,
    firedAt: sim.currentTime,
    scheduledAt: sim.currentTime,
    item,
  };

  if (!getRequest) {
    // There was no pending get request, store the put request
    store.putRequests = [done, ...store.putRequests];
  }

  // Yield continuation
  yield done;
}
