import type { EventID, Simulation, Timestamp } from "./model.ts";
import { EventState } from "./model.ts";

/** Entry stored in the event min-heap */
interface HeapEntry {
  scheduledAt: Timestamp;
  priority: number;
  /** Monotonic insertion counter used for LIFO tiebreaking at same time+priority */
  seq: number;
  id: EventID;
}

/**
 * Mutable min-heap for event scheduling.
 * Ordered by (`scheduledAt` ASC, `priority` ASC, `seq` DESC).
 * When `scheduledAt` and `priority` are equal, the last-scheduled event is dequeued first (LIFO).
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
 * Implements the queueing discipline for the simulation core.
 */
function compare(a: HeapEntry, b: HeapEntry): number {
  if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
  if (a.priority !== b.priority) return a.priority - b.priority;
  // LIFO tiebreak: higher seq (last inserted) should come first in a min-heap -> invert
  return b.seq - a.seq;
}

/**
 * Pushes an entry onto the heap in `O(log N)`.
 * Heap is mutated in-place.
 */
export function heapPush(
  heap: EventHeap,
  entry: { scheduledAt: Timestamp; priority: number; id: EventID },
): void {
  heap.entries.push({ ...entry, seq: heap.seq++ });
  siftUp(heap.entries, heap.entries.length - 1);
}

/**
 * Removes and returns the minimum entry from the heap in O(log N).
 * Heap is mutated in-place.
 * Returns undefined if empty.
 */
export function heapPop(heap: EventHeap): HeapEntry | undefined {
  const entries = heap.entries;
  if (entries.length === 0) return undefined;
  const top = entries[0];
  const last = entries.pop()!;
  if (entries.length > 0) {
    entries[0] = last;
    siftDown(entries, 0);
  }
  return top;
}

/**
 * Restores the heap property upward from index `i` after an insertion.
 */
function siftUp(entries: HeapEntry[], i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (compare(entries[i], entries[parent]) < 0) {
      [entries[i], entries[parent]] = [entries[parent], entries[i]];
      i = parent;
    } else break;
  }
}

/**
 * Restores the heap property downward from index `i` after a removal.
 */
function siftDown(entries: HeapEntry[], i: number): void {
  const n = entries.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < n && compare(entries[left], entries[smallest]) < 0) {
      smallest = left;
    }
    if (right < n && compare(entries[right], entries[smallest]) < 0) {
      smallest = right;
    }
    if (smallest === i) break;
    [entries[i], entries[smallest]] = [entries[smallest], entries[i]];
    i = smallest;
  }
}

/**
 * Builds a min-heap from all currently scheduled events in the simulation in `O(N)`.
 * Used to initialize or rebuild the heap (e.g., after a checkpoint prune).
 * Insertion order of scheduled events into the returned heap is unspecified.
 * `seq` values are assigned in `timeline.status` iteration order, which is sufficient to maintain heap invariants.
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
    siftDown(heap.entries, i);
  }
  return heap;
}
