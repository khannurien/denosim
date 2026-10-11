import type {
  CreateStoreOptions,
  DisciplineDefinition,
  Event,
  GetWhereRequest,
  Predicate,
  PredicateType,
  Simulation,
  StateData,
  Store,
  StoreID,
  StoreItemMap,
  StoreQueue,
  StoreQueueEntry,
  StoreRegistry,
  StoreResult,
} from "./model.ts";
import { heapPopWith, heapPushWith } from "./heap.ts";
import { continueEvent, resumeEvent } from "./simulation.ts";

/**
 * Enqueues `event` onto a `StoreQueue` heap in `O(log N)`.
 * Returns a new `StoreQueue` with the event inserted and the `seq` counter incremented.
 */
function storeQueuePush<T extends StateData>(
  queue: StoreQueue<T>,
  event: Event<T>,
  discipline: DisciplineDefinition,
): StoreQueue<T> {
  const entries = [...queue.entries];
  const entry: StoreQueueEntry<T> = { event, seq: queue.seq };
  heapPushWith(entries, entry, discipline.comparator);
  return { entries, seq: queue.seq + 1 };
}

/**
 * Dequeues the discipline-best event from a `StoreQueue` heap in `O(log N)`.
 * Returns `[event, updatedQueue]` or `null` if the queue is empty.
 */
function storeQueuePop<T extends StateData>(
  queue: StoreQueue<T>,
  discipline: DisciplineDefinition,
): [Event<T>, StoreQueue<T>] {
  const entries = [...queue.entries];
  const entry = heapPopWith(
    entries,
    discipline.comparator,
  )!;
  return [entry.event, { entries, seq: queue.seq }];
}

/**
 * Dequeues the discipline-best event from a `StoreQueue` that satisfies `predicate`, in `O(k log N)` where `k` is the number of rejections before a match.
 * Rejected candidates are re-inserted, preserving the heap.
 * Returns `[event, updatedQueue]` or `null` if no matching event exists.
 */
function storeQueuePopWhere<T extends StateData>(
  queue: StoreQueue<T>,
  discipline: DisciplineDefinition,
  predicate: (event: Event<T>) => boolean,
): [Event<T>, StoreQueue<T>] | null {
  const comparator = discipline.comparator;
  const queuedEntries = [...queue.entries];
  const rejectedEntries: StoreQueueEntry<T>[] = [];

  while (queuedEntries.length > 0) {
    const entry = heapPopWith(queuedEntries, comparator)!;
    if (predicate(entry.event)) {
      for (const rejected of rejectedEntries) {
        heapPushWith(queuedEntries, rejected, comparator);
      }
      return [entry.event, { entries: queuedEntries, seq: queue.seq }];
    }
    rejectedEntries.push(entry);
  }

  // No match: queue is logically unchanged (caller retains original)
  return null;
}

/**
 * Removes `event` from a `StoreQueue` heap in `O(N log N)`, rebuilding the heap from the remaining entries.
 * Returns a new `StoreQueue`; the `seq` counter is preserved.
 */
function storeQueueRemove<T extends StateData>(
  queue: StoreQueue<T>,
  event: Event,
  discipline: DisciplineDefinition,
): StoreQueue<T> {
  const comparator = discipline.comparator;
  const entries: StoreQueueEntry<T>[] = [];

  for (const entry of queue.entries) {
    if (entry.event.id !== event.id) heapPushWith(entries, entry, comparator);
  }

  return { entries, seq: queue.seq };
}

/**
 * Creates a new store with:
 * - Unique ID
 * - Optional capacity (defaults to 0: synchronous)
 * - A queue discipline key (defaults to `FIFO`)
 * All queues (`buffer`, `getRequests`, `putRequests`, `getWhereRequests`) start empty.
 * The returned store must be registered with `registerStore` before use in a simulation.
 */
export function initializeStore<T extends StateData = StateData>(
  options: CreateStoreOptions,
): Store<T> {
  return {
    id: options.id ?? crypto.randomUUID(),
    capacity: options.capacity ?? 0,
    discipline: options.discipline ?? "FIFO",
    buffer: { entries: [], seq: 0 },
    getRequests: { entries: [], seq: 0 },
    putRequests: { entries: [], seq: 0 },
    getWhereRequests: [],
  };
}

/**
 * Adds a store to the simulation's store registry and returns the updated store definitions.
 * Specify `T` explicitly to declare the item type held by the store (e.g. `registerStore<MyData>(sim, store)`).
 * The store's ID and item type are reflected in the return type, enabling typed access via `sim.stores[id]` in subsequent calls.
 */
export function registerStore<
  T extends StateData = StateData,
  S extends StoreItemMap = StoreItemMap,
  K extends StoreID = StoreID,
>(
  sim: Simulation<S>,
  store: Store<StateData, K>,
): StoreRegistry<S & Record<K, T>> {
  return {
    ...sim.stores,
    [store.id]: { ...store },
  } as StoreRegistry<S & Record<K, T>>;
}

/**
 * Looks up a store and its discipline from the simulation registries.
 * Throws `RangeError` if either is missing.
 */
function resolveStore<
  S extends StoreItemMap,
  K extends keyof S & StoreID,
>(
  sim: Simulation<S>,
  event: Event,
  id: K,
): { store: Store<S[K]>; discipline: DisciplineDefinition } {
  const store = sim.stores[id];
  if (!store) {
    throw new RangeError(
      `Store not found in registry: ${id}` +
        ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }
  const discipline = sim.disciplines[store.discipline];
  if (!discipline) {
    throw new RangeError(
      `Discipline definition not found in registry: ${store.discipline}` +
        ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }
  return { store, discipline };
}

/**
 * Looks up a predicate from the simulation registry.
 * Throws `RangeError` if missing.
 */
function resolvePredicate(
  sim: Simulation,
  event: Event,
  predicateType: PredicateType,
): Predicate {
  const predicate = sim.predicates[predicateType];
  if (!predicate) {
    throw new RangeError(
      `Predicate not found in registry: ${predicateType}` +
        ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }
  return predicate;
}

/**
 * Extracts the payload from a store event's `process.data` field.
 * Throws `TypeError` if missing.
 */
function resolvePayload<T extends StateData>(
  storeEvent: Event<T>,
  sim: Simulation,
  requestEvent: Event,
): T {
  const payload = storeEvent.process.data;
  if (payload === undefined) {
    throw new TypeError(
      `Store payload is missing for event: ${storeEvent.id}` +
        ` (scheduled at: ${requestEvent.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }
  return payload;
}

/**
 * Sends `data` to a store on behalf of `event`. Three cases:
 * - Pending consumer, unconditional or filtered with a predicate accepting the item: immediate handoff to the best one by discipline;
 * - Store at capacity (always, with a capacity of `0`): the producer blocks;
 * - Available capacity: the data is buffered.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function put<
  S extends StoreItemMap,
  K extends keyof S & StoreID = keyof S & StoreID,
  T extends S[K] = S[K],
>(
  sim: Simulation<S>,
  event: Event,
  id: K,
  data: T,
): StoreResult {
  const { store, discipline } = resolveStore<S, K>(sim, event, id);

  // Track the discipline-best getWhere request whose predicate accepts the item
  let best: { req: GetWhereRequest; index: number } | null = null;

  if (store.getWhereRequests.length > 0) {
    // Carries `data` so the predicate can inspect it
    const itemEvent = continueEvent(event, sim.currentTime, data);

    // Scan all getWhere requests; keep the one that wins under the store discipline
    for (let i = 0; i < store.getWhereRequests.length; i++) {
      // Look up the request's predicate by its registered key
      const req = store.getWhereRequests[i];
      const predicate = resolvePredicate(sim, event, req.predicateType);

      // Skip requests whose predicate rejects the item
      // Among those that accept, keep the discipline-best
      if (!predicate(itemEvent)) continue;
      if (
        !best ||
        discipline.comparator(req, best.req) < 0
      ) {
        best = { req, index: i };
      }
    }
  }

  // Unconditional pending get requests: the best one by discipline is at the root of the heap
  const unconditional = store.getRequests.entries.at(0);

  // The getWhere request is served if it wins over the unconditional one under the store discipline
  if (
    best && (
      !unconditional ||
      discipline.comparator(best.req, unconditional) < 0
    )
  ) {
    const remaining = [
      ...store.getWhereRequests.slice(0, best.index),
      ...store.getWhereRequests.slice(best.index + 1),
    ];

    sim.stores = {
      ...sim.stores,
      [store.id]: { ...store, getWhereRequests: remaining },
    };

    const updatedGet = resumeEvent(best.req.event, sim.currentTime, data);
    const updatedPut = continueEvent(event, sim.currentTime);

    return {
      step: updatedPut,
      resume: [updatedGet],
      finish: [best.req.event],
    };
  }

  // Otherwise the unconditional one is served, if any
  if (unconditional) {
    const [getRequest, remaining] = storeQueuePop(
      store.getRequests,
      discipline,
    );

    sim.stores = {
      ...sim.stores,
      [store.id]: { ...store, getRequests: remaining },
    };

    const updatedGet = resumeEvent(getRequest, sim.currentTime, data);
    const updatedPut = continueEvent(event, sim.currentTime);

    return { step: updatedPut, resume: [updatedGet], finish: [getRequest] };
  }

  // Store at capacity, without pending get request: block put
  if (store.buffer.entries.length >= store.capacity) {
    const blockedPut = continueEvent(event, sim.currentTime, data, {
      waiting: true,
    });

    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        putRequests: storeQueuePush(store.putRequests, blockedPut, discipline),
      },
    };

    // The request carries the item, but stands for the caller's continuation
    return { step: blockedPut };
  }

  // Capacity available: use buffer
  // The buffered item carries `data`; the producer's continuation does not, so its next step sees its own state
  const item = continueEvent(event, sim.currentTime, data);
  const updatedPut = continueEvent(event, sim.currentTime);

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      buffer: storeQueuePush(store.buffer, item, discipline),
    },
  };

  return { step: updatedPut };
}

/**
 * Shared logic for `get` and `getWhere`.
 * Scans `buffer` then `putRequests` for a matching item, applying `predicate` if provided.
 * When a buffered item is taken, a blocked producer (if any) takes the freed slot and is resumed.
 * Returns a `StoreResult` on an immediate match, * or `null` when no data is available and the caller must block.
 */
function tryGetImmediate<T extends StateData>(
  sim: Simulation<StoreItemMap>,
  event: Event,
  store: Store<T>,
  discipline: DisciplineDefinition,
  predicate?: (event: Event<T>) => boolean,
): StoreResult<T> | null {
  const id = store.id;

  // Scan buffer first, as buffered items entered the store before any blocked producer
  if (store.buffer.entries.length > 0) {
    const result = predicate
      ? storeQueuePopWhere(store.buffer, discipline, predicate)
      : storeQueuePop(store.buffer, discipline);

    // Match found: dequeue the buffered item and deliver it to the consumer
    if (result) {
      const [buffered, remaining] = result;

      const payload = resolvePayload(buffered, sim, event);
      const updatedGet = continueEvent(event, sim.currentTime, payload);

      // No blocked producer: the freed slot stays empty
      if (store.putRequests.entries.length === 0) {
        sim.stores = { ...sim.stores, [id]: { ...store, buffer: remaining } };

        return { step: updatedGet, item: payload };
      }

      // Blocked producer: the best one by discipline takes the freed slot and resumes
      const [putRequest, pending] = storeQueuePop(
        store.putRequests,
        discipline,
      );

      // Its request, which carries the item, becomes the buffered item
      const updatedPut = resumeEvent(putRequest, sim.currentTime);

      sim.stores = {
        ...sim.stores,
        [id]: {
          ...store,
          buffer: storeQueuePush(remaining, putRequest, discipline),
          putRequests: pending,
        },
      };

      return {
        step: updatedGet,
        item: payload,
        resume: [updatedPut],
        finish: [putRequest],
      };
    }
  }

  // Scan putRequests for a matching blocked producer
  if (store.putRequests.entries.length > 0) {
    const result = predicate
      ? storeQueuePopWhere(store.putRequests, discipline, predicate)
      : storeQueuePop(store.putRequests, discipline);

    // Match found: dequeue the producer, hand off the payload, resume both sides
    if (result) {
      const [putRequest, remaining] = result;

      sim.stores = {
        ...sim.stores,
        [id]: { ...store, putRequests: remaining },
      };

      const payload = resolvePayload(putRequest, sim, event);
      const updatedPut = resumeEvent(putRequest, sim.currentTime);
      const updatedGet = continueEvent(event, sim.currentTime, payload);

      return {
        step: updatedGet,
        item: payload,
        resume: [updatedPut],
        finish: [putRequest],
      };
    }
  }

  return null;
}

/**
 * Retrieves an item from a store on behalf of `event`. Three cases:
 * - Buffered data: the best buffered item by discipline is dequeued, returned as `item` and attached to the consumer's continuation. If a producer is pending, the best one by discipline takes the freed slot and is rescheduled;
 * - Pending producer, no buffered data: the get completes immediately. The best producer by discipline is dequeued and rescheduled; its request is cleaned up. Its item is returned as `item` and attached to the consumer's continuation;
 * - No data available: the consumer blocks.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function get<
  S extends StoreItemMap,
  K extends keyof S & StoreID = keyof S & StoreID,
>(
  sim: Simulation<S>,
  event: Event,
  id: K,
): StoreResult<S[K]> {
  const { store, discipline } = resolveStore<S, K>(sim, event, id);

  // Check putRequests and buffer for an available item; return immediately on a match
  const immediate = tryGetImmediate(sim, event, store, discipline);
  if (immediate) return immediate;

  // No data available: block get (in getRequests)
  // Keeps the caller's payload on the request so disciplines can rank waiting consumers by data
  const blockedGet = continueEvent(
    event,
    sim.currentTime,
    event.process.data,
    { waiting: true },
  );

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      getRequests: storeQueuePush(store.getRequests, blockedGet, discipline),
    },
  };

  return { step: blockedGet };
}

/**
 * Retrieves an item from a store only if it satisfies a caller-supplied predicate.
 * Looks for a match among buffered items first, then among blocked producers, whose item is handed off directly.
 * Selection among multiple matching items follows the store's discipline (including custom comparators), applied to each queue separately.
 * Blocks if no matching item is currently available; the caller will be resumed by the first future `put` whose data satisfies the predicate.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function getWhere<
  S extends StoreItemMap,
  K extends keyof S & StoreID,
>(
  sim: Simulation<S>,
  event: Event,
  id: K,
  predicateType: PredicateType,
): StoreResult<S[K]> {
  const { store, discipline } = resolveStore<S, K>(sim, event, id);
  const predicate = resolvePredicate(sim, event, predicateType);

  // Check putRequests and buffer for a matching item; return immediately on a match
  const immediate = tryGetImmediate(
    sim,
    event,
    store,
    discipline,
    predicate,
  );
  if (immediate) return immediate;

  // No match: block get (in getWhereRequests)
  // Keeps the caller's payload on the request so disciplines can rank waiting consumers by data
  const blockedGet = continueEvent(
    event,
    sim.currentTime,
    event.process.data,
    { waiting: true },
  );

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      // getWhere requests draw their arrival order from the `getRequests` counter
      getRequests: { ...store.getRequests, seq: store.getRequests.seq + 1 },
      getWhereRequests: [
        ...store.getWhereRequests,
        { event: blockedGet, predicateType, seq: store.getRequests.seq },
      ],
    },
  };

  return { step: blockedGet };
}

/**
 * Withdraws `request`, a blocked `get`, `getWhere` or `put`, from a store on behalf of `event`.
 * Used when a process stops waiting (e.g. on a timeout): finishing the request alone would leave it queued, and a later operation would resume it.
 * Returns `null` if the request is no longer queued, i.e. it has already been served and its process resumed.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function cancel<
  S extends StoreItemMap,
  K extends keyof S & StoreID = keyof S & StoreID,
  T extends StateData = StateData,
>(
  sim: Simulation<S>,
  event: Event<T>,
  id: K,
  request: Event,
): StoreResult<T> | null {
  const { store, discipline } = resolveStore<S, K>(sim, event, id);

  const getRequests = storeQueueRemove(store.getRequests, request, discipline);
  const putRequests = storeQueueRemove(store.putRequests, request, discipline);
  const getWhereRequests = store.getWhereRequests.filter((req) =>
    req.event.id !== request.id
  );

  // Request no longer queued: it has already been served
  if (
    getRequests.entries.length === store.getRequests.entries.length &&
    putRequests.entries.length === store.putRequests.entries.length &&
    getWhereRequests.length === store.getWhereRequests.length
  ) {
    return null;
  }

  sim.stores = {
    ...sim.stores,
    [store.id]: { ...store, getRequests, putRequests, getWhereRequests },
  };

  return { step: continueEvent(event, sim.currentTime), finish: [request] };
}
