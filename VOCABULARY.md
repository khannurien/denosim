# Vocabulary

Current state of the terms used in the library: concepts, types, and non-trivial method or field names.
The last column flags names that do not say what they do.

## Simulation

| Term | Meaning today | To fix |
| --- | --- | --- |
| `Simulation` | Container for the whole simulation: `currentTime`, `timeline`, `processes`, `disciplines`, `predicates`, `states`, `stores` | |
| `currentTime` | Scheduled time of the last handled event | |
| `Timeline` | `events` (definitions), `status` (current `EventStatus` per event), `transitions` (log of status changes) | |
| `Simulation.states` | The `ProcessState` saved by each handled event, keyed by event ID | |
| `Simulation.processes` | Registry of process definitions, keyed by `ProcessType` | |
| `advance` | Pops the next scheduled event and handles it | |
| `handleEvent` (internal) | Handles one event: advances time, runs its step, finishes and schedules events | |
| `runStep` (internal) | Resolves the process state of an event and runs its step handler | |
| `runSimulation` | Runs until no event is left, or until `untilTime` / `untilEvent` | |
| `rate` | Wall-clock throttling, in handled events per second | |
| `SimulationStats` | `end` (simulation time) and `duration` (wall-clock milliseconds) | |

## Events

| Term | Meaning today | To fix |
| --- | --- | --- |
| `Event` | Unit of scheduling: `id`, `parent`, `waiting`, `priority`, `scheduledAt`, `process` | |
| `Event.parent` | The event whose saved state this event inherits | |
| `Event.waiting` | The event is created in `Waiting` state and is never handled | |
| `Event.priority` | Tie-break at equal `scheduledAt`; lower value first | |
| `Event.process` | The process this event belongs to, as a `ProcessCall`: `type`, `continues`, `data` (payload) | |
| `continues` | The event continues the process of its parent (same step, same process ID) instead of spawning a new one; requires `parent` | |
| `EventStatus` | `Scheduled`, `Waiting`, `Finished`; an event goes `Scheduled` then `Finished`, or `Waiting` then `Finished` | |
| `EventTransition` | One entry of the timeline log: event ID, status reached, time | |
| `createEvent` | Builds an event; does not add it to the timeline | |
| `scheduleEvent` | Adds an event to the timeline: `Scheduled`, or `Waiting` if `waiting` | |
| `finishEvent` | Marks an event `Finished` | |
| `continueEvent` | Builds the continuation of an event: same process, parent is the event | |
| `resumeEvent` | Builds the continuation of a blocked process from its request: parent is the request's parent | |
| request | A `Waiting` continuation queued in a store, standing for a blocked `get`, `getWhere` or `put`; never handled; its `scheduledAt` is the time of the request | |
| `EventHeap` | Min-heap of scheduled events: time, then priority, then insertion order | |

## Processes

| Term | Meaning today | To fix |
| --- | --- | --- |
| process | The events sharing a `ProcessID`, each continuing from the state saved by its parent: a chain, or a tree after a fork | |
| `ProcessDefinition` | `type`, `initial` step, `steps` (one handler per step) | |
| `ProcessType`, `StepType` | User-defined names of a process definition and of a step; a "type" is a string key in a registry (also `DisciplineType`, `PredicateType`) | |
| `ProcessID` | ID of the event that started the process | |
| `ProcessHandler` | Function run for one step: `(sim, event, state) => StepResult` | |
| `ProcessState` | `id`, `spawner`, `type`, `step`, `data` | |
| `ProcessState.step` | The step the process is at: the one being run in a handler; in a returned or saved state, the one its next event will run | |
| `ProcessState.spawner` | Process ID of the spawner, if any | |
| `StepResult` | What a handler returns: `state`, `next`, `finish` | |
| `next` | Events to add to the timeline after the step | |
| `finish` | Events to mark `Finished` after the step, besides the handled one | |
| `StateData` | Any process data or store item: `Record<string, unknown>` | Used for both state and items |
| `StepStateMap` | Maps each step name to the data type its handler receives | |
| `none` | Built-in no-op process, default for events without one | |
| continuation | Event with `parent` and `continues`: same process, next step | |
| fork | Several continuations emitted from one step | |
| spawn | Event with `parent`, without `continues`: new process inheriting data | |
| root process | Event without `parent`: new process, no inheritance | |

## Stores

| Term | Meaning today | To fix |
| --- | --- | --- |
| `Store` | `id`, `capacity`, `discipline`, `buffer`, `getRequests`, `putRequests`, `getWhereRequests` | |
| `capacity` | Number of items the store holds before a `put` blocks. `0` (default): synchronous, a `put` waits for a `get` and nothing is held | |
| item | The data a process puts and gets: the `T` of a store | |
| item event | The event carrying an item in `process.data` while it is in a store; what predicates and comparators receive | |
| token | An item standing for one unit of a resource | |
| `buffer` | Item events held by the store | |
| `getRequests`, `putRequests` | Requests of blocked consumers and producers; only the producers' carry items | |
| `getWhereRequests` | Requests of consumers blocked in `getWhere`, with their predicate key; a plain array, scanned on each `put` to test the predicates against the item | |
| `StoreQueue`, `StoreQueueEntry` | Heap of events ordered by the store discipline; `seq` is the arrival order; an entry is passed as is to the comparator | |
| `put`, `get`, `getWhere`, `cancel` | Store operations: send an item, take one, take one matching a predicate, withdraw a blocked request | |
| `StoreResult` | What a store operation returns: `step`, `item`, `resume`, `finish` | |
| `StoreResult.step` | Continuation event of the calling process, or its request if it blocked | An event, not a step |
| `StoreResult.item` | Item received by a `get` or `getWhere` that completed immediately: an early copy. The item always arrives merged into the data of the next step, including when the caller blocks | |
| `StoreResult.resume` | Continuation events of the other side, to add to `next` | |
| `initializeStore`, `registerStore` | Build a store; add it to `sim.stores` | |
| `StoreItemMap` | Type-level map from store ID to item type; a `ProcessDefinition` can declare one so that store operations in its handlers are checked | |
| `StoreRegistry` | Map from store ID to store; the type of `sim.stores` | |
| `QueueDiscipline` | Built-in discipline keys: `FIFO`, `LIFO` | |
| `DisciplineDefinition` | A discipline key and its `comparator` | |
| `DisciplineEntry` | What a comparator receives: `event` and `seq` (arrival order) | |
| `Predicate`, `PredicateDefinition` | Function over an item event, and its key, used by `getWhere` | |

## Runs and persistence

| Term | Meaning today | To fix |
| --- | --- | --- |
| run | One execution of `runSimulation`, with a `runId` and a `runDirectory` | |
| `RunManifest` | Contents of `run.json`: identity, timestamps, dump state, user metadata | |
| `RunContext` | Manifest and its path, passed along the run loop | |
| snapshot | A copy of the whole simulation at one point in time | |
| delta | Difference between two consecutive simulation states | |
| `SimulationDelta` | Fields `c`, `e`, `es`, `et`, `s`, `st`: time, events, statuses, transitions, states, stores | Abbreviated field names |
| `DeltaEncodedSimulation` | `base` state, `deltas` since the base, `current` state | |
| dump | File holding a base and its deltas, written every `dumpInterval` handled events | |
| `pruneWorkingState` | Drops finished events and unreferenced state from memory after a dump | |
| `serializeSimulation`, `deserializeSimulation` | JSON round-trip of simulation states; registries are passed back in on the way in | |
| `reconstructFullCurrent`, `loadRunHistory` | Rebuild the final state, or every intermediate state, from dump files | |
