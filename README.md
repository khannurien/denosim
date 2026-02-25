# ⏳ denosim

A discrete-event simulation library for Deno. Features a stateful, event-driven process-as-state-machine model with UNIX-like `fork`/`exec` semantics, explicit process continuations, and inter-process synchronization.

## Main characteristics and features

- ⚙️ Define **processes** using finite-state machines -- your code determines state transitions;
- 🔗 Use **resources** to model shared data -- synchronize processes using `put`/`get` semantics;
- ⏯️ Leverage **immutability** to pause and resume simulations -- snapshot the whole simulation state and restore it later.

Planned features:

- 🔌 Socket-based **communication** -- easily build user interfaces;
- 🌐 Run **distributed** simulations -- deploy processes on different machines.

## Process model and event scheduling

**Process representation**

- Each process is a finite state machine: `ProcessDefinition` drives transitions; runtime snapshot is `ProcessState` containing process step and data;
- Steps are explicit `ProcessStep` values; user defines how their process transitions from one state to another.

**Scheduling and execution semantics**

- Processes execute only when an associated `Event` is dequeued. Events are ordered by scheduled time then priority;
- Simulation advances time with each event, executes their process, updates the process state, and schedules any new events returned.

**Lifecycle and persistence**

- Process instances are stored in a global simulation state;
- An event is never reprocessed and is marked `Finished` as it has been handled.

**Concurrency / composition model**

- Child processes are spawned by emitting new events; parent–child relationships are tracked via parent on events;
- Three spawn styles supported: `fork`-like continuation (child keeps parent process type and current progress/state); `exec`-like inheritance (child inherits parent data but starts at the process initial step) and `execve`-like spawn (clean state from process definition and explicitly provided input data);
- Blocking is modeled by a `Waiting` event state and by resumption through newly emitted continuation events when conditions are satisfied.

**Continuations & temporal patterns**

- Process logic is continuation-driven: each step returns the next event(s) that carry execution forward;
- A process step does not "loop": state-machine progress happens only through emitted next event(s), including revisiting the same step in a later transition;
- "Sleeping" is modeled by returning a continuation scheduled in the future.

**Messaging / data flow**

- Data flows via process data and step inheritance flags;
- Events contain a `ProcessCall` that can carry initialization data for process state; child processes can merge inherited state;
- This lets workflows evolve over multiple events (*e.g.*, arrive -> wait -> handle -> done) while carrying context forward.

## Setup

Install Deno; see [the guide](https://docs.deno.com/runtime/getting_started/installation/).

## Usage

Run the examples:

```sh
deno task example_scheduling
deno task example_synchronization
deno task example_stack_size
```

## Development

Run tests:

```sh
deno task test
```
