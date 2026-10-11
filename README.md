# ⏳ denosim

A discrete-event simulation library for Deno.

Denosim is made for people who explore scheduling:
- finite time: it allows to model tasks (with temporal and data dependencies);
- finite space: it allows to represent resources allocation.

Both data dependencies and resources allocation rely on **stores**: processes block on `put`/`get`, and an item is either data or a token (a resource is a store holding tokens).

Denosim features a stateful, event-driven process-as-state-machine model with UNIX-inspired `fork`/spawn semantics, explicit process continuations, and inter-process synchronization through stores.

## Main characteristics and features

- ⚙️ Define **processes** using finite-state machines -- your code determines state transitions, and can `fork` or spawn processes;
- ⏱️ Schedule **events** in simulated time -- use timeouts to model durations and continuations to chain tasks;
- 🔗 Use **stores** to model both shared capacity and data handoff -- synchronize processes by blocking on `put`/`get`;
- 🚦 Order store queues using **queue disciplines** (`FIFO`, `LIFO`, or your own) -- select specific items using `getWhere` predicates;
- ⏯️ Leverage **immutability** to pause and resume simulations -- snapshot the whole simulation state and restore it later, *e.g.*, to compare policies (**FIXME**: usage not documented yet).

Planned features:

- 📊 **FIXME**: collect **metrics** -- read wait times, lateness or occupancy out of a run; for now they are computed by hand from process state;
- 🔌 Socket-based **communication** -- easily build user interfaces;
- 🌐 Run **distributed** simulations -- deploy processes on different machines.

## Process model and event scheduling

**Process representation**

- Each process is a finite state machine: `ProcessDefinition` drives transitions; runtime state is `ProcessState` containing process step and data;
- Each step has a handler returning a `StepResult`: the updated state and the next event(s); user defines how their process transitions from one state to another;
- A process is a chain of events, each continuing from the state saved by its `parent` event; it is identified by the ID of the event that started it.

**Scheduling and execution semantics**

- Processes execute only when an associated `Event` is dequeued. Events are ordered by scheduled time, then priority (lower value first), then scheduling order;
- Simulation advances time with each event, executes their process, updates the process state, and schedules any new events returned.

**Lifecycle and persistence**

- Process state is stored in a global simulation state, one saved state per handled event;
- An event is never reprocessed: it is marked `Finished` once handled, or once the process it was blocking resumes;
- A run leaves the simulation it started from untouched; its history is kept on demand, in memory or dumped to disk.

**Concurrency and composition model**

- Processes are started and continued by emitting new events, linked through `parent`;
- Four patterns supported: continuation (same process, next step); `fork` (several continuations from one step, each with its own copy of the state); spawn (new process at its initial step, inheriting parent data and recording its spawner) and root process (no parent, only explicitly provided data);
- Forked copies share their process identifier; alternatives (*e.g.*, an item or a timeout) must cancel each other, through `finish` for a scheduled event and `cancel` for a store request;
- Blocking is modeled by a `Waiting` event status and by resumption through newly emitted continuation events when conditions are satisfied.

**Continuations and temporal patterns**

- Process logic is continuation-driven: each step returns the next event(s) that carry execution forward;
- A process step does not "loop": state-machine progress happens only through emitted next event(s), including revisiting the same step in a later transition;
- A timeout is a continuation scheduled in the future: the process sleeps until then;
- A task that depends on another is started by an event emitted when the first one finishes.

**Messaging and data flow**

- Data flows via process data: the state returned by a step is what the next step sees;
- Events contain a `ProcessCall` that can carry data, merged over the inherited state;
- Processes exchange data through stores (`put`, `get`, `getWhere`), synchronous by default or buffered up to `capacity`; a received item is merged the same way;
- A store operation returns events (`step`, `resume`, `finish`) that the handler must pass on; each blocking operation resumes the process on its own, so a step waiting on several is a `fork`;
- This lets workflows evolve over multiple events (*e.g.*, arrive -> wait -> handle -> done) while carrying context forward.

## Setup

Install Deno; see [the guide](https://docs.deno.com/runtime/getting_started/installation/).

## Usage

**FIXME**: simple examples going through real-world use cases.

## Development

### Tests

```sh
deno task test
```

### Profiling

```sh
# built-in CPU profiling (.cpuprofile output)
deno run -A --cpu-prof --cpu-prof-interval=100 --cpu-prof-name=profile.cpuprofile examples/stack-size.ts
# V8 CPU profiling (.log output)
deno run -A --v8-flags=--prof,--prof-sampling-interval=100,--log-deopt examples/stack-size.ts
```

Analyze the resulting output with [cpupro](https://discoveryjs.github.io/cpupro/) or similar tools.
