import { Event, ProcessStep, Simulation, Store } from "./model.ts";
import { scheduleEvent } from "./simulation.ts";

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
 * If there is none in store, yields control and resumes when an item becomes available.
 * The requested item will eventually be stored in the event.item property.
 */
export function* get<T>(
  sim: Simulation,
  event: Event<T>,
  store: Store<T>,
): ProcessStep<T> {
  // If an item has already been fetched into the request, return it
  // Otherwise, if an item is already available in the store, fetch it
  const item = event.item ?? store.items.pop();

  // FIXME: Footgunned with immutability
  // Problem: callback has already returned a generator which is tied to the OG event
  // This generator won't operate on the new event!
  // const getRequest = { ...event, scheduledAt: sim.currentTime, item };
  const getRequest = event;
  getRequest.scheduledAt = sim.currentTime;
  getRequest.item = item;

  // If there is no item available, emit a get request
  if (!item) {
    // Store the event in request queue
    store.requests = [...store.requests, getRequest];
  }

  // Reschedule the event
  sim.events = scheduleEvent(sim, getRequest);

  // Yield control (allowing other code to run until request completes)
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
  } else {
    // Put the item in the request and reschedule it
    const putRequest = { ...request, scheduledAt: sim.currentTime, item };
    sim.events = scheduleEvent(sim, putRequest);
  }

  // Yield control
  yield;
}
