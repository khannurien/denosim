import {
  Event,
  EventState,
  Process,
  Simulation,
  SimulationStats,
} from "./model.ts";

export function initializeSimulation(): Simulation {
  return {
    currentTime: 0,
    events: [],
  };
}

export function runSimulation(sim: Simulation): SimulationStats {
  const start = performance.now();

  while (true) {
    const eventsTodo = sim.events.filter((event) =>
      (event.scheduledAt >= sim.currentTime) &&
      (event.status === EventState.Scheduled)
    ).sort((a, b) => b.scheduledAt - a.scheduledAt);

    const event = eventsTodo.pop();

    if (!event) {
      break;
    }

    sim.currentTime = event.scheduledAt;
    const finished = handleEvent(sim, event);
    sim.events = [finished, ...sim.events];
  }

  const end = performance.now();

  return {
    duration: end - start,
  };
}

export function createEvent(
  sim: Simulation,
  scheduledAt: number,
  callback?: Process,
): Event {
  return {
    id: crypto.randomUUID(),
    status: EventState.Fired,
    firedAt: sim.currentTime,
    scheduledAt,
    callback: callback ?? function* () {
      yield;
    },
  };
}

export function scheduleEvent(sim: Simulation, event: Event): Event[] {
  if (event.scheduledAt < sim.currentTime) {
    throw RangeError(
      `Event scheduled at a point in time in the past: ${event.id} ` +
        `(scheduled at: ${event.scheduledAt}; current time: ${sim.currentTime})`,
    );
  }

  return [...sim.events, { ...event, status: EventState.Scheduled }];
}

export function handleEvent(sim: Simulation, event: Event): Event {
  const generator = event.callback(sim, event);
  const { value, done } = generator.next();

  sim.events = sim.events.filter((previous) => previous.id !== event.id);

  if (!done && value) {
    sim.events = scheduleEvent(sim, {
      ...event,
      scheduledAt: value.scheduledAt,
      callback: function* (_sim: Simulation, _event: Event) {
        yield* generator;
      },
    });
  }

  return {
    ...event,
    finishedAt: sim.currentTime,
    status: EventState.Finished,
  };
}

export function* timeout(
  sim: Simulation,
  duration: number,
  callback?: Process,
): Generator<Event | void, void, void> {
  const timeoutEvent = createEvent(
    sim,
    sim.currentTime + duration,
    callback,
  );

  sim.events = scheduleEvent(sim, timeoutEvent);

  yield timeoutEvent;
}
