import { Event, EventState, Process, Simulation } from "./model.ts";

export function initializeSimulation(): Simulation {
  return {
    currentTime: 0,
    events: [],
  };
}

export function runSimulation(sim: Simulation) {
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
  return [{ ...event, status: EventState.Scheduled }, ...sim.events];
}

export function handleEvent(sim: Simulation, event: Event): Event {
  const generator = event.callback(sim, event);
  const { value, done } = generator.next();

  sim.events = sim.events.filter((previous) => previous.id !== event.id);

  if (!done && value) {
    const scheduledAt = value.scheduledAt > sim.currentTime
      ? value.scheduledAt
      : sim.currentTime;

    sim.events = scheduleEvent(sim, {
      ...event,
      status: EventState.Scheduled,
      scheduledAt: scheduledAt,
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
    callback ?? function* () {
      yield;
    },
  );

  sim.events = scheduleEvent(sim, timeoutEvent);

  yield timeoutEvent;
}
