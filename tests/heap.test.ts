import { assertEquals } from "@std/assert";

import {
  buildHeap,
  createHeap,
  heapPop,
  heapPopWith,
  heapPush,
  heapPushWith,
} from "../src/heap.ts";
import { EventState } from "../src/model.ts";
import {
  createEvent,
  initializeSimulation,
  scheduleEvent,
} from "../src/simulation.ts";

const numCmp = (a: number, b: number) => a - b;

Deno.test("createHeap returns an empty heap with seq 0", () => {
  const heap = createHeap();
  assertEquals(heap.entries.length, 0);
  assertEquals(heap.seq, 0);
});

Deno.test("heapPush / heapPop dequeue in simulation ordering (scheduledAt ASC, priority ASC, seq ASC)", () => {
  const heap = createHeap();

  const ids = ["a", "b", "c"];
  heapPush(heap, { scheduledAt: 10, priority: 0, id: ids[0] });
  heapPush(heap, { scheduledAt: 5, priority: 0, id: ids[1] });
  heapPush(heap, { scheduledAt: 10, priority: -1, id: ids[2] }); // higher priority (lower number)

  // seq counter advances on each push
  assertEquals(heap.seq, 3);

  // Expected order: scheduledAt=5 first, then priority=-1 at t=10, then priority=0 at t=10
  const first = heapPop(heap);
  const second = heapPop(heap);
  const third = heapPop(heap);

  assertEquals(first?.id, ids[1]); // t=5
  assertEquals(second?.id, ids[2]); // t=10, priority=-1
  assertEquals(third?.id, ids[0]); // t=10, priority=0
});

Deno.test("heapPop returns undefined on empty EventHeap", () => {
  const heap = createHeap();
  assertEquals(heapPop(heap), undefined);
});

Deno.test("heapPush / heapPop FIFO tiebreak: first scheduled fires first at equal time+priority", () => {
  const heap = createHeap();

  const ids = ["first", "second", "third"];
  heapPush(heap, { scheduledAt: 0, priority: 0, id: ids[0] });
  heapPush(heap, { scheduledAt: 0, priority: 0, id: ids[1] });
  heapPush(heap, { scheduledAt: 0, priority: 0, id: ids[2] });

  // FIFO: first pushed should come out first
  assertEquals(heapPop(heap)?.id, ids[0]);
  assertEquals(heapPop(heap)?.id, ids[1]);
  assertEquals(heapPop(heap)?.id, ids[2]);
});

Deno.test("buildHeap produces correct min-heap order from simulation state", () => {
  const sim = initializeSimulation();

  const e1 = createEvent({ scheduledAt: 20 });
  const e2 = createEvent({ scheduledAt: 5 });
  const e3 = createEvent({ scheduledAt: 10 });
  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);
  sim.timeline = scheduleEvent(sim, e3);

  const heap = buildHeap(sim);

  // All three Scheduled events included; minimum scheduledAt dequeues first
  assertEquals(heap.entries.length, 3);
  assertEquals(heapPop(heap)?.id, e2.id); // t=5
  assertEquals(heapPop(heap)?.id, e3.id); // t=10
  assertEquals(heapPop(heap)?.id, e1.id); // t=20
});

Deno.test("buildHeap returns empty heap when no Scheduled events exist", () => {
  const sim = initializeSimulation();

  // Add a Waiting event — buildHeap must skip it
  const e = createEvent({ scheduledAt: 10, waiting: true });
  sim.timeline = scheduleEvent(sim, e);
  assertEquals(sim.timeline.status[e.id], EventState.Waiting);

  const heap = buildHeap(sim);
  assertEquals(heap.entries.length, 0);
});

Deno.test("buildHeap skips Finished events", () => {
  const sim = initializeSimulation();

  const e1 = createEvent({ scheduledAt: 5 });
  const e2 = createEvent({ scheduledAt: 10 });
  sim.timeline = scheduleEvent(sim, e1);
  sim.timeline = scheduleEvent(sim, e2);

  // Manually finish e1
  sim.timeline.status[e1.id] = EventState.Finished;

  const heap = buildHeap(sim);
  assertEquals(heap.entries.length, 1);
  assertEquals(heap.entries[0].id, e2.id);
});

Deno.test("heapPopWith returns undefined on empty array", () => {
  const entries: number[] = [];
  assertEquals(heapPopWith(entries, numCmp), undefined);
});

Deno.test("heapPushWith / heapPopWith dequeue in min-heap order", () => {
  const entries: number[] = [];
  for (const n of [5, 2, 8, 1, 3]) heapPushWith(entries, n, numCmp);

  const result: number[] = [];
  let v: number | undefined;
  while ((v = heapPopWith(entries, numCmp)) !== undefined) result.push(v);

  assertEquals(result, [1, 2, 3, 5, 8]);
});

Deno.test("heapPushWith / heapPopWith respect a reversed comparator (max-heap)", () => {
  const maxCmp = (a: number, b: number) => b - a;
  const entries: number[] = [];
  for (const n of [4, 7, 1, 9, 2]) heapPushWith(entries, n, maxCmp);

  assertEquals(heapPopWith(entries, maxCmp), 9);
  assertEquals(heapPopWith(entries, maxCmp), 7);
  assertEquals(heapPopWith(entries, maxCmp), 4);
});
