import type {
  CreateEventOptions,
  CreateStoreOptions,
  DisciplineDefinition,
  Event,
  PredicateType,
  Simulation,
  StateData,
  Store,
  StoreDefinitions,
  StoreID,
  StoreQueue,
  StoreQueueEntry,
  StoreRegistry,
  StoreResult,
  Timestamp,
} from "./model.ts";
import { heapPopWith, heapPushWith } from "./heap.ts";
import { createEvent } from "./simulation.ts";

/**
 * Type guard that narrows a store event's `process.data` field from `StateData | undefined` to `T`.
 * Used internally before accessing payload data from resumed put requests or buffered items.
 */
function hasStorePayload<T extends StateData>(
  payload: StateData | undefined,
): payload is T {
  return payload !== undefined;
}

/**
 * Returns the comparator to use for a `StoreQueue` heap, wrapping the discipline comparator so that `StoreQueueEntry.seq` maps to `DisciplineEntry.index` (arrival order).
 */
function disciplineToQueueComparator<T extends StateData>(
  discipline: DisciplineDefinition,
): (a: StoreQueueEntry<T>, b: StoreQueueEntry<T>) => number {
  return (a, b) =>
    discipline.comparator({ event: a.event, index: a.seq }, {
      event: b.event,
      index: b.seq,
    });
}

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
  heapPushWith(entries, entry, disciplineToQueueComparator<T>(discipline));
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
    disciplineToQueueComparator<T>(discipline),
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
  predicate: (data: T) => boolean,
): [Event<T>, StoreQueue<T>] | null {
  const cmp = disciplineToQueueComparator<T>(discipline);
  const entries = [...queue.entries];
  const rejected: StoreQueueEntry<T>[] = [];

  while (entries.length > 0) {
    const entry = heapPopWith(entries, cmp)!;
    const data = entry.event.process.data;
    if (data !== undefined && predicate(data as T)) {
      for (const r of rejected) heapPushWith(entries, r, cmp);
      return [entry.event, { entries, seq: queue.seq }];
    }
    rejected.push(entry);
  }

  // No match — queue is logically unchanged (caller retains original)
  return null;
}

/**
 * Advances `event` to its next step. `event.id` becomes the parent of the new event.
 * Pass `data` to replace the payload; use `options` to set `waiting`, `priority`, etc.
 */
export function continueEvent<T extends StateData>(
  event: Event<T>,
  currentTime: Timestamp,
  data?: T,
  options?: Pick<CreateEventOptions, "waiting" | "priority">,
): Event<T> {
  return createEvent({
    parent: event.id,
    scheduledAt: currentTime,
    ...options,
    process: data !== undefined
      ? { ...event.process, inheritStep: true, data: { ...data } }
      : { ...event.process, inheritStep: true },
  });
}

/**
 * Resumes a waiting event with new data. `blocked.parent` becomes the parent of the new event.
 * Used when a producer delivers to a blocked consumer, or vice-versa: the blocked event provides the process step to resume; the data comes from the other side.
 */
export function resumeEvent<T extends StateData>(
  blocked: Event<StateData>,
  currentTime: Timestamp,
  data: T,
  options?: Pick<CreateEventOptions, "priority">,
): Event<T> {
  return createEvent({
    parent: blocked.parent,
    scheduledAt: currentTime,
    ...options,
    process: { ...blocked.process, inheritStep: true, data: { ...data } },
  });
}

/**
 * Creates a new store with:
 * - Unique ID
 * - Optional capacity (defaults to 1)
 * - Blocking or non-blocking behavior (defaults to `true`)
 * - A queue discipline key (defaults to `FIFO`)
 * All queues (`buffer`, `getRequests`, `putRequests`, `filteredGetRequests`) start empty.
 * The returned store must be registered with `registerStore` before use in a simulation.
 */
export function initializeStore<T extends StateData = StateData>(
  options: CreateStoreOptions,
): Store<T> {
  return {
    id: options.id ?? crypto.randomUUID(),
    capacity: options.capacity ?? 1,
    blocking: options.blocking ?? true,
    discipline: options.discipline ?? "FIFO",
    buffer: { entries: [], seq: 0 },
    getRequests: { entries: [], seq: 0 },
    putRequests: { entries: [], seq: 0 },
    filteredGetRequests: [],
  };
}

/**
 * Adds a store to the simulation's store registry and returns the updated store definitions.
 * Specify `T` explicitly to declare the item type held by the store (e.g. `registerStore<MyData>(sim, store)`).
 * The store's ID and item type are reflected in the return type, enabling typed access via `sim.stores[id]` in subsequent calls.
 */
export function registerStore<
  T extends StateData = StateData,
  S extends StoreRegistry = StoreRegistry,
  K extends StoreID = StoreID,
>(
  sim: Simulation<S>,
  store: Store<StateData, K>,
): StoreDefinitions<S & Record<K, T>> {
  return {
    ...sim.stores,
    [store.id]: { ...store },
  } as StoreDefinitions<S & Record<K, T>>;
}

/**
 * Sends `data` to a store on behalf of `event`. Four cases:
 * - Unconditional pending consumer: immediate handoff by discipline order;
 * - Filtered pending consumer: immediate handoff;
 * - Blocking store, or non-blocking store at capacity: the producer blocks;
 * - Non-blocking store with available capacity: the data is buffered.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function put<
  S extends StoreRegistry,
  K extends keyof S & StoreID = keyof S & StoreID,
  T extends S[K] = S[K],
>(
  sim: Simulation<S>,
  event: Event<T>,
  id: K,
  data: T,
): StoreResult<T> {
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

  // Check for unconditional pending get requests
  if (store.getRequests.entries.length > 0) {
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

  // Check for filtered get requests (getWhere waiters)
  // Single reduce pass in discipline order — same pattern as selectFromArray
  if (store.filteredGetRequests.length > 0) {
    let best: {
      req: { event: Event<StateData>; predicateType: PredicateType };
      index: number;
    } | null = null;

    for (let i = 0; i < store.filteredGetRequests.length; i++) {
      const req = store.filteredGetRequests[i];
      const predicate = sim.predicates[req.predicateType];
      if (!predicate) {
        throw new RangeError(
          `Predicate not found in registry: ${req.predicateType}` +
            ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
        );
      }
      if (!predicate(data)) continue;
      if (
        !best ||
        discipline.comparator(
            { event: req.event, index: i },
            { event: best.req.event, index: best.index },
          ) < 0
      ) {
        best = { req, index: i };
      }
    }

    if (best) {
      const remaining = [
        ...store.filteredGetRequests.slice(0, best.index),
        ...store.filteredGetRequests.slice(best.index + 1),
      ];

      sim.stores = {
        ...sim.stores,
        [store.id]: { ...store, filteredGetRequests: remaining },
      };

      const updatedGet = resumeEvent(best.req.event, sim.currentTime, data);
      const updatedPut = continueEvent(event, sim.currentTime);

      return {
        step: updatedPut,
        resume: [updatedGet],
        finish: [best.req.event],
      };
    }
  }

  // Blocking store or non-blocking store without pending get request: block put
  if (store.blocking || store.buffer.entries.length >= store.capacity) {
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

    return { step: blockedPut };
  }

  // Non-blocking store with capacity available: use buffer
  const updatedPut = continueEvent(event, sim.currentTime, data);

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      buffer: storeQueuePush(store.buffer, updatedPut, discipline),
    },
  };

  return { step: updatedPut };
}

/**
 * Shared logic for `get` and `getWhere`.
 * Scans `putRequests` then `buffer` (non-blocking stores only) for a matching item, applying `predicate` if provided.
 * Returns a `StoreResult` on an immediate match, * or `null` when no data is available and the caller must block.
 */
function tryGetImmediate<T extends StateData>(
  sim: Simulation<StoreRegistry>,
  event: Event<T>,
  store: Store<T>,
  discipline: DisciplineDefinition,
  predicate?: (data: T) => boolean,
): StoreResult<T> | null {
  const id = store.id;

  // Scan putRequests for a matching blocked producer
  if (store.putRequests.entries.length > 0) {
    const result = predicate
      ? storeQueuePopWhere(store.putRequests, discipline, predicate)
      : storeQueuePop(store.putRequests, discipline);

    if (result !== null) {
      const [putRequest, remaining] = result;

      sim.stores = {
        ...sim.stores,
        [id]: { ...store, putRequests: remaining },
      };

      const payload = putRequest.process.data;
      if (!hasStorePayload<T>(payload)) {
        throw new TypeError(
          `Store payload is missing for resumed put request: ${id}` +
            ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
        );
      }

      const updatedPut = resumeEvent(putRequest, sim.currentTime, payload);
      const updatedGet = continueEvent(event, sim.currentTime, payload);

      return { step: updatedGet, resume: [updatedPut], finish: [putRequest] };
    }
  }

  // Non-blocking stores: scan buffer
  if (!store.blocking && store.buffer.entries.length > 0) {
    const result = predicate
      ? storeQueuePopWhere(store.buffer, discipline, predicate)
      : storeQueuePop(store.buffer, discipline);

    if (result !== null) {
      const [buffered, remaining] = result;

      sim.stores = { ...sim.stores, [id]: { ...store, buffer: remaining } };

      const payload = buffered.process.data;
      if (!hasStorePayload<T>(payload)) {
        throw new TypeError(
          `Store payload is missing for buffered item: ${id}` +
            ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
        );
      }

      const updatedGet = continueEvent(event, sim.currentTime, payload);

      return { step: updatedGet };
    }
  }

  return null;
}

/**
 * Retrieves an item from a store on behalf of `event`. Three cases:
 * - Pending producer: the get completes immediately. The best producer by discipline is dequeued and rescheduled; its waiting placeholder is cleaned up. The consumer receives a continuation event with the data attached;
 * - Non-blocking store with buffered data: the best buffered item by discipline is dequeued and its data attached to the consumer's continuation;
 * - No data available: the consumer blocks.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function get<
  S extends StoreRegistry,
  K extends keyof S & StoreID = keyof S & StoreID,
  T extends S[K] = S[K],
>(
  sim: Simulation<S>,
  event: Event<T>,
  id: K,
): StoreResult<T> {
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

  const immediate = tryGetImmediate(
    sim,
    event,
    store as Store<T>,
    discipline,
  );

  if (immediate) return immediate;

  // No data available: block get
  const blockedGet = continueEvent(event, sim.currentTime, undefined, {
    waiting: true,
  });

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
 * Selection among multiple matching items follows the store's discipline (including custom comparators).
 * Blocks if no matching item is currently available; the caller will be resumed by the first future `put` whose data satisfies the predicate.
 * Mutates `sim.stores` directly and returns a `StoreResult` describing the continuation.
 */
export function getWhere<
  S extends StoreRegistry,
  K extends keyof S & StoreID,
>(
  sim: Simulation<S>,
  event: Event<S[K]>,
  id: K,
  predicateType: PredicateType,
): StoreResult<S[K]> {
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

  const predicate = sim.predicates[predicateType];
  if (!predicate) {
    throw new RangeError(
      `Predicate not found in registry: ${predicateType}` +
        ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  const immediate = tryGetImmediate(
    sim,
    event,
    store,
    discipline,
    predicate,
  );
  if (immediate) return immediate;

  // No match: block get
  const blockedGet = continueEvent(event, sim.currentTime, undefined, {
    waiting: true,
  });

  sim.stores = {
    ...sim.stores,
    [store.id]: {
      ...store,
      filteredGetRequests: [
        ...store.filteredGetRequests,
        { event: blockedGet, predicateType },
      ],
    },
  };

  return { step: blockedGet };
}
