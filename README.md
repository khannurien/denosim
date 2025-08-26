# ⏳ denosim

A process-based, discrete-event simulation library for Deno.

Main characteristics and features:

- ⚙️ Define **processes** using finite state machines -- your code determines state transitions;
- 🔗 Use **resources** to model shared data -- synchronize processes using `put`/`get` semantics;
- ⏯️ Leverage **immutability** to pause and resume simulations -- snapshot the whole simulation state and restore it later.

Planned features:

- 🔌 Socket-based **communication** -- easily build user interfaces;
- 🌐 Run **distributed** simulations -- deploy processes on different machines.

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
