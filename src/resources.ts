import { Event, ProcessStep, Simulation, Store } from "./model.ts";

/**
 * Creates a new store with:
 * - Unique ID
 * - Array of initial items (defaults to an empty array)
 * - Empty requests array (no scheduled get requests)
 */
export function createStore<T>(initialItems: T[] = []): Store<T> {
  return {
    id: crypto.randomUUID(),
    items: initialItems,
    requests: [],
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
  // If an item has already been fetched into the request, return it
  // Otherwise, if an item is already available in the store, fetch it
  // TODO: Avoid side-effect on store.items
  const item = event.item ?? store.items.pop();

  // Return the item immediately if found
  if (item) {
    return item;
  }

  // Update the event with the item if it exists
  // Emit a get request for when an item will be made available in the store
  const getRequest: Event<T> = {
    ...event,
    firedAt: sim.currentTime,
    scheduledAt: sim.currentTime,
  };

  // If there is no item available, emit a get request
  if (!item) {
    // Store the event in request queue
    store.requests = [...store.requests, getRequest];
    // Yield control
    yield;
  } else {
    // Yield continuation
    yield getRequest;
  }
}

/**
 * Puts an item in a store.
 * If there are pending get requests, handles the earliest one with said item.
 * Otherwise, stores the item for future requests.
 * Yields control immediately.
 */
export function* put<T>(
  sim: Simulation,
  _event: Event<T>,
  store: Store<T>,
  item: T,
): ProcessStep<T> {
  // Sort requests in descending order so we can efficiently pop the earliest request
  const requestsTodo = store.requests.sort((a, b) =>
    b.scheduledAt - a.scheduledAt
  );
  const request = requestsTodo.pop();

  if (!request) {
    // There was no pending request, just store the item
    store.items = [item, ...store.items];
    // Yield control
    yield;
  } else {
    // Put the item in the request
    const putRequest = {
      ...request,
      firedAt: sim.currentTime,
      scheduledAt: sim.currentTime,
      item,
    };
    // Yield continuation
    yield putRequest;
  }
}
