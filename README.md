# ⏳ denosim

A discrete-event simulation library for Deno. Features a stateful, event-driven process-as-state-machine model with UNIX-like `fork`/`exec` semantics, explicit process continuations, and inter-process synchronization.

## Main characteristics and features

- ⚙️ Define **processes** using finite state machines -- your code determines state transitions;
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
- Two spawn styles supported: inheritance (`fork`-like -- child inherits parent data and step) and fresh (`exec`-like -- clean state from process definition);
- Blocking is modeled by a `Waiting` state and by conditional event emission (timeouts, explicit continuations).

**Continuations & temporal patterns**

- Supports explicit continuations and timeouts: processes can yield future events as continuations or schedule timed events to model delays.

**Messaging / data flow**

- Data flows via process data and step inheritance flags;
- Events contain a `ProcessCall` that can carry initialization data for process state; child processes can merge inherited state.

## Setup

Install Deno; see [the guide](https://docs.deno.com/runtime/getting_started/installation/).

## Usage

Run the example:

```sh
deno run examples/scheduling.ts
```

## Development

Run tests:

```sh
deno test
```
