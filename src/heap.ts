import type { EventID, Simulation, Timestamp } from "./model.ts";
import { EventState } from "./model.ts";

/** Entry stored in the event min-heap */
interface HeapEntry {
  scheduledAt: Timestamp;
  priority: number;
  /** Monotonic insertion counter used for FIFO tiebreaking at same time+priority */
  seq: number;
  id: EventID;
}

/**
 * Mutable min-heap for event scheduling.
 * Ordered by (`scheduledAt` ASC, `priority` ASC, `seq` ASC).
 * When `scheduledAt` and `priority` are equal, the first-scheduled event is dequeued first (FIFO).
 */
export interface EventHeap {
  entries: HeapEntry[];
  /** Monotonically increasing insertion counter */
  seq: number;
}

/**
 * Creates an empty min-heap for `O(log N)` event scheduling.
 * Returns the empty heap with its insertion counter set to `0`.
 */
export function createHeap(): EventHeap {
  return { entries: [], seq: 0 };
}

/**
 * Comparator for `EventHeap` entries: `scheduledAt` ASC, `priority` ASC, `seq` ASC.
 */
function compareByTimePriorityFIFO(a: HeapEntry, b: HeapEntry): number {
  if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
  if (a.priority !== b.priority) return a.priority - b.priority;
  // FIFO tiebreak: lower seq (first scheduled) comes first
  return a.seq - b.seq;
}

/**
 * Pushes an entry onto the heap in `O(log N)`.
 * Heap is mutated in-place.
 */
export function heapPush(
  heap: EventHeap,
  entry: { scheduledAt: Timestamp; priority: number; id: EventID },
): void {
  heapPushWith(
    heap.entries,
    { ...entry, seq: heap.seq++ },
    compareByTimePriorityFIFO,
  );
}

/**
 * Removes and returns the minimum entry from the heap in `O(log N)`.
 * Heap is mutated in-place.
 * Returns `undefined` if empty.
 */
export function heapPop(heap: EventHeap): HeapEntry | undefined {
  return heapPopWith(heap.entries, compareByTimePriorityFIFO);
}

/**
 * Generic sift-up: restores the heap property upward from index `i` using a caller-supplied comparator.
 */
function siftUpWith<T>(
  entries: T[],
  i: number,
  comparator: (a: T, b: T) => number,
): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;

    if (comparator(entries[i], entries[parent]) < 0) {
      [entries[i], entries[parent]] = [entries[parent], entries[i]];
      i = parent;
    } else break;
  }
}

/**
 * Generic sift-down: restores the heap property downward from index `i` using a caller-supplied comparator.
 */
function siftDownWith<T>(
  entries: T[],
  i: number,
  comparator: (a: T, b: T) => number,
): void {
  const n = entries.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;

    if (left < n && comparator(entries[left], entries[smallest]) < 0) {
      smallest = left;
    }
    if (right < n && comparator(entries[right], entries[smallest]) < 0) {
      smallest = right;
    }
    if (smallest === i) break;

    [entries[i], entries[smallest]] = [entries[smallest], entries[i]];
    i = smallest;
  }
}

/**
 * Pushes `entry` onto a generic min-heap in `O(log N)`.
 * `entries` is mutated in-place.
 * `comparator` must be the same comparator used with `heapPopWith` on this array.
 */
export function heapPushWith<T>(
  entries: T[],
  entry: T,
  comparator: (a: T, b: T) => number,
): void {
  entries.push(entry);
  siftUpWith(entries, entries.length - 1, comparator);
}

/**
 * Removes and returns the minimum entry from a generic min-heap in `O(log N)`.
 * `entries` is mutated in-place.
 * Returns `undefined` if empty.
 */
export function heapPopWith<T>(
  entries: T[],
  comparator: (a: T, b: T) => number,
): T | undefined {
  if (entries.length === 0) return undefined;

  const top = entries[0];
  const last = entries.pop()!;

  if (entries.length > 0) {
    entries[0] = last;
    siftDownWith(entries, 0, comparator);
  }

  return top;
}

/**
 * Builds a min-heap from all currently scheduled events in the simulation in `O(N)`.
 * Used to initialize or rebuild the heap (e.g., after a checkpoint prune).
 * `seq` values are assigned in `timeline.status` iteration order (i.e. original scheduling order), which preserves FIFO semantics across rebuilds.
 */
export function buildHeap(sim: Simulation): EventHeap {
  const heap = createHeap();
  for (const [id, status] of Object.entries(sim.timeline.status)) {
    if (status === EventState.Scheduled) {
      const event = sim.timeline.events[id];
      if (event && event.scheduledAt >= sim.currentTime) {
        heap.entries.push({
          scheduledAt: event.scheduledAt,
          priority: event.priority,
          seq: heap.seq++,
          id,
        });
      }
    }
  }

  // Floyd's algorithm: build heap in-place in O(N)
  for (let i = (heap.entries.length >> 1) - 1; i >= 0; i--) {
    siftDownWith(heap.entries, i, compareByTimePriorityFIFO);
  }
  return heap;
}
