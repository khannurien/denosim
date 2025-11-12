import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createEvent,
  deserializeSimulation,
  Event,
  EventState,
  initializeSimulation,
  ProcessDefinition,
  ProcessHandler,
  registerProcess,
  runSimulation,
  scheduleEvent,
  serializeSimulation,
  StateData,
} from "../mod.ts";

Deno.test("basic serialization", async () => {
  const sim = initializeSimulation();

  interface DummyData extends StateData {
    value: number;
  }

  const dummy: ProcessDefinition<{
    start: [DummyData, []];
  }> = {
    type: "dummy",
    initial: "start",
    steps: {
      start(_sim, event, state) {
        return {
          state,
          next: [],
        };
      },
    },
  };

  sim.registry = registerProcess(sim, dummy);

  const e = createEvent(sim, {
    scheduledAt: 0,
    process: {
      type: "dummy",
      data: { value: 42 },
    },
  });

  sim.events = scheduleEvent(sim, e);

  const [states, _stats] = await runSimulation(sim);

  const json = serializeSimulation(states);
  const recovered = deserializeSimulation(json);

  assertEquals(recovered.length, states.length);
  assertEquals(recovered[recovered.length - 1].currentTime, 0);
  assertEquals(recovered[recovered.length - 1].events.length, 1);
  assertEquals(recovered[recovered.length - 1].state[e.id].data.value, 42);

  const restoredHandler = recovered[0].registry["dummy"].steps["start"];
  assert(typeof restoredHandler === "function");
});

Deno.test("process state serialization", async () => {
});

Deno.test("process resume across runs", async () => {
});

Deno.test("process rewind", async () => {
});
