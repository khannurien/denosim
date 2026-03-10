import type {
  CreateStoreOptions,
  DisciplineDefinition,
  Event,
  PredicateType,
  Simulation,
  StateData,
  Store,
  StoreDefinitions,
  StoreID,
  StoreRegistry,
  StoreResult,
} from "./model.ts";
import { QueueDiscipline } from "./model.ts";
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
 * Selects the best candidate from a queue according to the given discipline definition.
 * An optional predicate filters candidates before discipline ranking is applied.
 * Returns `[selectedEvent, remainingQueue]`, or `null` if no candidate matches the predicate.
 */
function selectFromQueue<T extends StateData>(
  queue: Event<T>[],
  definition: DisciplineDefinition,
  predicate?: (data: T) => boolean,
): [Event<T>, Event<T>[]] | null {
  // Pair candidates with their original queue index
  // FIFO: lowest index wins; LIFO: highest index wins (even when filtering)
  const entries = queue.map((event, index) => ({ event, index }));

  const candidates = predicate
    ? entries.filter(({ event }) => {
      const data = event.process.data;
      return data !== undefined && predicate(data);
    })
    : entries;

  if (candidates.length === 0) return null;

  // Single linear scan to find the minimum-ranked candidate
  const best = candidates.reduce((bestEntry, entry) =>
    definition.comparator(entry, bestEntry) < 0 ? entry : bestEntry
  );

  const remaining = [
    ...queue.slice(0, best.index),
    ...queue.slice(best.index + 1),
  ];

  return [best.event, remaining];
}

/**
 * Creates a new store with:
 * - Unique ID
 * - Optional capacity (defaults to 1)
 * - Blocking or non-blocking behavior (defaults to `true`)
 * - A queue discipline key (defaults to `LIFO`)
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
    discipline: options.discipline ?? QueueDiscipline.LIFO,
    buffer: [],
    getRequests: [],
    putRequests: [],
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
  if (store.getRequests.length > 0) {
    const result = selectFromQueue(store.getRequests, discipline);
    const [getRequest, remaining] = result!;

    sim.stores = {
      ...sim.stores,
      [store.id]: { ...store, getRequests: remaining },
    };

    const updatedGet: Event<T> = createEvent({
      parent: getRequest.parent,
      scheduledAt: sim.currentTime,
      process: {
        ...getRequest.process,
        inheritStep: true,
        data: { ...data },
      },
    });

    const updatedPut: Event<T> = createEvent({
      parent: event.id,
      scheduledAt: sim.currentTime,
      process: { ...event.process, inheritStep: true },
    });

    return { step: updatedPut, resume: [updatedGet], finish: [getRequest] };
  }

  // Check for filtered get requests (getWhere waiters)
  // Iterate waiters in discipline order; serve the first whose predicate accepts the data
  if (store.filteredGetRequests.length > 0) {
    const entries = store.filteredGetRequests.map((req, index) => ({
      req,
      index,
    }));

    const sorted = [...entries].sort((a, b) =>
      discipline.comparator(
        { event: a.req.event, index: a.index },
        { event: b.req.event, index: b.index },
      )
    );

    const matched = sorted.find(({ req }) => {
      const predicate = sim.predicates[req.predicateType];
      if (!predicate) {
        throw new RangeError(
          `Predicate not found in registry: ${req.predicateType}` +
            ` (scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
        );
      }

      return predicate(data);
    });

    if (matched) {
      const remaining = [
        ...store.filteredGetRequests.slice(0, matched.index),
        ...store.filteredGetRequests.slice(matched.index + 1),
      ];

      sim.stores = {
        ...sim.stores,
        [store.id]: { ...store, filteredGetRequests: remaining },
      };

      const updatedGet: Event<T> = createEvent({
        parent: matched.req.event.parent,
        scheduledAt: sim.currentTime,
        process: {
          ...matched.req.event.process,
          inheritStep: true,
          data: { ...data },
        },
      });

      const updatedPut: Event<T> = createEvent({
        parent: event.id,
        scheduledAt: sim.currentTime,
        process: { ...event.process, inheritStep: true },
      });

      return {
        step: updatedPut,
        resume: [updatedGet],
        finish: [matched.req.event],
      };
    }
  }

  // Blocking store or non-blocking store without pending get request: block put
  if (store.blocking || store.buffer.length >= store.capacity) {
    const blockedPut: Event<T> = createEvent({
      parent: event.id,
      waiting: true,
      scheduledAt: sim.currentTime,
      process: {
        ...event.process,
        inheritStep: true,
        data: { ...data },
      },
    });

    sim.stores = {
      ...sim.stores,
      [store.id]: {
        ...store,
        putRequests: [...store.putRequests, blockedPut],
      },
    };

    return { step: blockedPut };
  }

  // Non-blocking store with capacity available: use buffer
  const updatedPut: Event<T> = createEvent({
    parent: event.id,
    scheduledAt: sim.currentTime,
    process: {
      ...event.process,
      inheritStep: true,
      data: { ...data },
    },
  });

  sim.stores = {
    ...sim.stores,
    [store.id]: { ...store, buffer: [...store.buffer, updatedPut] },
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
  if (store.putRequests.length > 0) {
    const result = selectFromQueue(
      store.putRequests,
      discipline,
      predicate,
    );

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

      const updatedPut: Event<T> = createEvent({
        parent: putRequest.parent,
        scheduledAt: sim.currentTime,
        process: {
          ...putRequest.process,
          inheritStep: true,
          data: { ...payload },
        },
      });

      const updatedGet: Event<T> = createEvent({
        parent: event.id,
        scheduledAt: sim.currentTime,
        process: { ...event.process, inheritStep: true, data: { ...payload } },
      });

      return { step: updatedGet, resume: [updatedPut], finish: [putRequest] };
    }
  }

  // Non-blocking stores: scan buffer
  if (!store.blocking && store.buffer.length > 0) {
    const result = selectFromQueue(
      store.buffer,
      discipline,
      predicate,
    );

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

      const updatedGet: Event<T> = createEvent({
        parent: event.id,
        scheduledAt: sim.currentTime,
        process: { ...event.process, inheritStep: true, data: { ...payload } },
      });

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
  const blockedGet = createEvent({
    parent: event.id,
    scheduledAt: sim.currentTime,
    waiting: true,
    process: { ...event.process, inheritStep: true },
  });

  sim.stores = {
    ...sim.stores,
    [store.id]: { ...store, getRequests: [...store.getRequests, blockedGet] },
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
  const blockedGet = createEvent({
    parent: event.id,
    scheduledAt: sim.currentTime,
    waiting: true,
    process: { ...event.process, inheritStep: true },
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
