# Public API

Current state of what `mod.ts` exports: 72 symbols, 20 functions and the types they use; the examples use 21 of them.
Signatures are given without their type parameters; terms are defined in `VOCABULARY.md`.
The last column flags what is awkward or wrong.

## Setting up a simulation

| Export | Does today | To fix |
| --- | --- | --- |
| `initializeSimulation(): Simulation` | Empty simulation at time `0`, with the `none` process and the `FIFO` and `LIFO` disciplines | |
| `registerProcess(sim, definition): ProcessRegistry` | Returns the registry with the definition added; the caller assigns it to `sim.processes` | |
| `registerDiscipline(sim, definition): DisciplineRegistry` | Same, for `sim.disciplines` | |
| `registerPredicate(sim, definition): PredicateRegistry` | Same, for `sim.predicates` | |
| `initializeStore(options): Store` | Builds an empty store; does not add it to the simulation | `initialize` here, `create` in `CreateStoreOptions` and `createEvent` |
| `registerStore<T>(sim, store): StoreRegistry` | Returns the stores with this one added, typed by its items `T`; the caller assigns it to `sim.stores` | |
| `createEvent(options): Event` | Builds an event: `scheduledAt`, and optionally `parent`, `process`, `priority`, `waiting`; does not add it to the timeline | |
| `scheduleEvent(sim, event): Timeline` | Returns the timeline with the event added; throws `RangeError` if `scheduledAt` is in the past; the caller assigns it to `sim.timeline` | |

## Writing a process

| Export | Does today | To fix |
| --- | --- | --- |
| `ProcessDefinition<M, S>` | `type`, `initial`, `steps`; `M` maps each step to its data, `S` each store to its items | |
| `ProcessHandler` | `(sim, event, state) => StepResult` | |
| `StepResult` | `state`, `next`, `finish` | |
| `continueEvent(event, scheduledAt, data?, options?): Event` | Continuation of `event`: same process, next step; `data` is merged over the process data; `options` is `waiting`, `priority` | |
| `createEvent` with `parent`, without `continues` | Spawn: new process at its initial step, with the parent's data, and `spawner` set | Same state as a root process given a copy of the data, apart from `spawner`, which nothing reads |
| `createEvent` without `parent` | Root process: only the data passed | |
| `resumeEvent(blocked, scheduledAt, data?, options?): Event` | Continuation of the process blocked on a request | Only called by store operations |
| `finishEvent(sim, event): Timeline` | Returns the timeline with the event marked `Finished` | Only called by the event loop and the tests; a handler goes through `finish` |

## Stores

| Export | Does today | To fix |
| --- | --- | --- |
| `put(sim, event, id, item): StoreResult` | Sends an item on behalf of `event`: handed to a blocked consumer, buffered, or the caller blocks | Store operations replace `sim.stores` in place; the rest of the API returns the part to assign |
| `get(sim, event, id): StoreResult` | Takes the best item by discipline, or the caller blocks | |
| `getWhere(sim, event, id, predicateType): StoreResult` | Same, among the items accepted by a registered predicate | |
| `cancel(sim, event, id, request): StoreResult \| null` | Withdraws a blocked request; `null` if it has already been served | |
| `StoreResult` | `step`, `item`, `resume`, `finish`; the handler passes `step` and `resume` in `next`, `finish` in `finish` | `step` is an event, not a step |
| `QueueDiscipline` | `FIFO`, `LIFO` | |
| `DisciplineDefinition`, `DisciplineComparator`, `DisciplineEntry` | A discipline key, its comparator, and what the comparator receives | |
| `PredicateDefinition`, `Predicate` | A predicate key and its function over an item event | |

## Running

| Export | Does today | To fix |
| --- | --- | --- |
| `runSimulation(sim, options?): Promise<SimulationResult>` | Handles events until none is left, or until `until` returns `true`; `sim` is left untouched | |
| `RunSimulationOptions.until` | `(sim, next) => boolean`, checked before `next` is handled; when `true` the run stops and `next` stays `Scheduled` | With a `rate` it is called twice per event: no side effect |
| `RunSimulationOptions.rate` | Simulation time units per wall-clock second: the run waits before each event | Without it, or a `directory`, the loop never yields: nothing outside can ask for a pause |
| `RunSimulationOptions.history` | `HistoryOptions`: `directory`, `interval` (handled events per window, `1000` by default), `metadata` | |
| `SimulationResult` | `result` (final simulation, complete), `stats`, and `history` (the windows) when asked without a `directory` | |
| `SimulationStats` | `end` (simulation time), `duration` (wall-clock milliseconds) | |

What a run does today, checked by running it:

- Nothing is written to disk without `history.directory`; the examples run with no permission;
- `until: (_sim, next) => next.scheduledAt > T` handles every event at or before `T`, and none after;
- The working state is compacted every 100 handled events, whether the history is kept or not; the returned simulation is complete, as if nothing had been pruned;
- With a `directory`, each window is a dump `dumps/<count>-t<time>.json`, next to `run.json`; a run in a directory that already holds dumps adds its own after them.

## Pausing, resuming, branching, rewinding

| Need | Done today with | To fix |
| --- | --- | --- |
| Pause | `until`: on a time, on the next event, on any state, or on a flag set from outside | |
| Resume | `runSimulation(result)`: same end as an uninterrupted run, before any event | |
| Branch | One copy `{ ...paused }` per branch, `scheduleEvent` on each, one run each; `paused` is left untouched | Not documented; two branches in one `directory` interleave their windows |
| History | `history: {}` returns the windows; `history: { directory }` writes them, `loadHistory(directory, sim)` reads them back | A resumed run returns its own windows: the caller concatenates |
| Rewind | `historyStates(windows)[k]`: the state after `k` handled events, complete; windows of a resumed run follow those of the first | Builds every state: quadratic in memory |
| Save | `serializeSimulation(sim)`: registries left out | |
| Restore | `deserializeSimulation(json, sim)`: registries taken from any simulation holding them | |

## Not exported

Importable from `src/`, as the tests do:

| Module | Functions |
| --- | --- |
| `heap.ts` | `createHeap`, `buildHeap`, `heapPush`, `heapPeek`, `heapPop`, `heapPushWith`, `heapPopWith` |
| `memory.ts` | `createDelta`, `applyDeltas`, `reconstructFromDeltas`, `pruneWorkingState`, `absorbWorkingState`; `createHistoryWindow` (tests only) |
| `runner.ts` | `initializeRun`, `dumpToDisk`, `shouldDump`, `persistRunManifest` |
| `serialize.ts` | `serializeForDump`, `deserializeDump` |
| `simulation.ts` | `nextEvent`, `advance` |

`deno doc --lint mod.ts` reports no error.

## Types

All of `model.ts` is exported (41 types); see `VOCABULARY.md`.
`runner.ts` exports `RunSimulationOptions`, `HistoryOptions`, `SimulationResult`, `SimulationStats`; `memory.ts` exports `HistoryWindow`, `SimulationDelta` and its five `*DeltaOp`.
