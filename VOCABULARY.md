# Vocabulary

Current state of the terms used in the library: concepts, types, and non-trivial method or field names.
The last column flags names that do not say what they do.

## Simulation

| Term                     | Meaning today                                                                                                               | To fix |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| `Simulation`             | Container for the whole simulation: `currentTime`, `timeline`, `processes`, `disciplines`, `predicates`, `states`, `stores` |        |
| `currentTime`            | Scheduled time of the last handled event                                                                                    |        |
| `Timeline`               | `events` (definitions), `status` (current `EventStatus` per event), `transitions` (log of status changes)                   |        |
| `Simulation.states`      | The `ProcessState` saved by each handled event, keyed by event ID                                                           |        |
| `Simulation.processes`   | Registry of process definitions, keyed by `ProcessType`                                                                     |        |
| `nextEvent`              | Returns the next scheduled event, without handling it                                                                       |        |
| `advance`                | Pops the next scheduled event and handles it                                                                                |        |
| `handleEvent` (internal) | Handles one event: advances time, runs its step, finishes and schedules events                                              |        |
| `runStep` (internal)     | Resolves the process state of an event and runs its step handler                                                            |        |
| `runSimulation`          | Runs until no event is left, or until `until` returns `true`; leaves its input untouched                                    |        |
| `until`                  | Stop condition over the simulation and the next event, checked before that event is handled                                 |        |
| `rate`                   | Playback speed, in simulation time units per wall-clock second                                                              |        |
| `SimulationRegistries`   | `processes`, `disciplines`, `predicates`: what is never serialized                                                          |        |
| `SimulationStats`        | `end` (simulation time) and `duration` (wall-clock milliseconds)                                                            |        |

## Events

| Term              | Meaning today                                                                                                                                              | To fix |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `Event`           | Unit of scheduling: `id`, `parent`, `waiting`, `priority`, `scheduledAt`, `process`                                                                        |        |
| `Event.parent`    | The event whose process this event continues, from the state saved for it                                                                                  |        |
| `Event.waiting`   | The event is created in `Waiting` state and is never handled                                                                                               |        |
| `Event.priority`  | Tie-break at equal `scheduledAt`; lower value first                                                                                                        |        |
| `Event.process`   | The process this event belongs to, as a `ProcessCall`: `type`, `data` (payload: read from the event, never merged into the process data)                   |        |
| `EventStatus`     | `Scheduled`, `Waiting`, `Finished`; an event goes `Scheduled` then `Finished`, or `Waiting` then `Finished`                                                |        |
| `EventTransition` | One entry of the timeline log: event ID, status reached, time                                                                                              |        |
| `createEvent`     | Builds an event; does not add it to the timeline; a process named by its definition (`ProcessStart`) is started with data checked against its initial step |        |
| `scheduleEvent`   | Adds an event to the timeline: `Scheduled`, or `Waiting` if `waiting`                                                                                      |        |
| `finishEvent`     | Marks an event `Finished`                                                                                                                                  |        |
| `continueEvent`   | Builds the continuation of an event: same process, parent is the event                                                                                     |        |
| `resumeEvent`     | Builds the continuation of a blocked process from its request: parent is the request's parent                                                              |        |
| request           | A `Waiting` continuation queued in a store, standing for a blocked `get`, `getWhere` or `put`; never handled; its `scheduledAt` is the time of the request |        |
| `EventHeap`       | Min-heap of scheduled events: time, then priority, then insertion order                                                                                    |        |

## Processes

| Term                      | Meaning today                                                                                                                             | To fix                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| process                   | The events sharing a `ProcessID`, each continuing from the state saved by its parent: a chain, or a tree after a fork                     |                               |
| `ProcessDefinition`       | `type`, `initial` step, `steps` (one handler per step)                                                                                    |                               |
| `ProcessType`, `StepType` | User-defined names of a process definition and of a step; a "type" is a string key in a registry (also `DisciplineType`, `PredicateType`) |                               |
| `ProcessID`               | ID of the event that started the process                                                                                                  |                               |
| `ProcessHandler`          | Function run for one step: `(sim, event, state) => StepResult`                                                                            |                               |
| `ProcessState`            | `id`, `type`, `step`, `data`                                                                                                              |                               |
| `ProcessState.step`       | The step the process is at: the one being run in a handler; in a returned or saved state, the one its next event will run                 |                               |
| `StepResult`              | What a handler returns: `state`, `next`, `finish`                                                                                         |                               |
| `next`                    | Events to add to the timeline after the step                                                                                              |                               |
| `finish`                  | Events to mark `Finished` after the step, besides the handled one                                                                         |                               |
| `StateData`               | Any process data or store item: `Record<string, unknown>`                                                                                 | Used for both state and items |
| `StepStateMap`            | Maps each step name to the data type its handler receives                                                                                 |                               |
| `StepEventMap`            | Maps a step name to the type of what the event running it brings: an item, or the data of a continuation                                  |                               |
| `none`                    | Built-in no-op process, default for events without one                                                                                    |                               |
| continuation              | Event with a `parent`: same process, next step                                                                                            |                               |
| fork                      | Several continuations emitted from one step                                                                                               |                               |
| root process              | Event without `parent`: new process, at its initial step, with the data passed                                                            |                               |

## Stores

| Term                               | Meaning today                                                                                                                                                                                | To fix               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `Store`                            | `capacity`, `discipline`, `consumerDiscipline`, `buffer`, `getRequests`, `putRequests`, `getWhereRequests`; its ID is its key in `sim.stores`                                                |                      |
| `capacity`                         | Number of items the store holds before a `put` blocks. `0` (default): synchronous, a `put` waits for a `get` and nothing is held                                                             |                      |
| item                               | The data a process puts and gets: the `T` of a store                                                                                                                                         |                      |
| item event                         | The event carrying an item in `process.data` while it is in a store; what predicates and comparators receive                                                                                 |                      |
| token                              | An item standing for one unit of a resource                                                                                                                                                  |                      |
| `buffer`                           | Item events held by the store                                                                                                                                                                |                      |
| `getRequests`, `putRequests`       | Requests of blocked consumers and producers; only the producers' carry items                                                                                                                 |                      |
| `getWhereRequests`                 | Requests of consumers blocked in `getWhere`, with their predicate key; a plain array, scanned on each `put` to test the predicates against the item                                          |                      |
| `StoreQueue`, `StoreQueueEntry`    | Heap of events ordered by a discipline of the store; `seq` is the arrival order; an entry is passed as is to the comparator                                                                  |                      |
| `put`, `get`, `getWhere`, `cancel` | Store operations: send an item, take one, take one matching a predicate, withdraw a blocked request                                                                                          |                      |
| `StoreResult`                      | What a store operation returns: `step`, `item`, `resume`, `finish`                                                                                                                           |                      |
| `StoreResult.step`                 | Continuation event of the calling process, or its request if it blocked                                                                                                                      | An event, not a step |
| `StoreResult.item`                 | Item received by a `get` or `getWhere` that completed immediately: an early copy. The item always arrives as the data of the event that runs the next step, including when the caller blocks |                      |
| `StoreResult.resume`               | Continuation events of the other side, to add to `next`                                                                                                                                      |                      |
| `initializeStore`, `registerStore` | Build a store; add it to `sim.stores` under an ID                                                                                                                                            |                      |
| `reorderStore`                     | Reorder the queues of a store under the disciplines it now points to                                                                                                                         |                      |
| `StoreItemMap`                     | Type-level map from store ID to item type; a `ProcessDefinition` or a `Simulation` can declare one so that store operations are checked                                                      |                      |
| `StoreRegistry`                    | Map from store ID to store; the type of `sim.stores`                                                                                                                                         |                      |
| `QueueDiscipline`                  | Built-in discipline keys: `FIFO`, `LIFO`                                                                                                                                                     |                      |
| `DisciplineDefinition`             | A discipline key and its `comparator`: over items as a store's `discipline`, over the data of blocked consumers as its `consumerDiscipline`                                                  |                      |
| `DisciplineEntry`                  | What a comparator receives: `event` and `seq` (arrival order)                                                                                                                                |                      |
| `Predicate`, `PredicateDefinition` | Function over an item event and the consumer's request, and its key, used by `getWhere`                                                                                                      |                      |

## Runs and persistence

| Term                                           | Meaning today                                                                                                     | To fix                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- |
| run                                            | One execution of `runSimulation`                                                                                  |                         |
| pause, resume                                  | A run stopped by `until` or `signal`; a run of its result                                                         |                         |
| branch                                         | Several runs from the same simulation                                                                             |                         |
| history                                        | Every intermediate state of a run, kept as a sequence of windows; asked with `history`                            |                         |
| window, `HistoryWindow`                        | `base` state and `deltas` since the base, one per handled event; `interval` handled events per window             |                         |
| `HistoryOptions`                               | `directory`, `interval`, `metadata`; without `directory` the windows are returned, with it they are written there |                         |
| `RunManifest`                                  | Contents of `run.json`: timestamps, dump state, user metadata                                                     |                         |
| `RunContext`                                   | Manifest and its path, passed along the run loop                                                                  |                         |
| snapshot                                       | A copy of the whole simulation at one point in time                                                               |                         |
| delta                                          | Difference between two consecutive simulation states                                                              |                         |
| `SimulationDelta`                              | Fields `c`, `e`, `es`, `et`, `s`, `st`: time, events, statuses, transitions, states, stores                       | Abbreviated field names |
| dump                                           | File holding a window                                                                                             |                         |
| working state                                  | The simulation the run loop advances: complete until the first compaction, then without the finished events       |                         |
| compaction                                     | Every 100 handled events: the working state is folded into the complete state (`absorbWorkingState`), then pruned |                         |
| `pruneWorkingState`                            | Drops finished events and unreferenced state from the working state                                               |                         |
| `serializeSimulation`, `deserializeSimulation` | JSON round-trip of one simulation; registries are left out, and passed back in on the way in                      |                         |
| `loadHistory`                                  | Reads the windows written to a directory                                                                          |                         |
| `historyStates`                                | Rebuilds every intermediate state, complete, from windows                                                         |                         |
