import { Event, EventState, Process, Simulation } from "./model.ts";

export function initialize_simulation(): Simulation {
  return {
    current_time: 0,
    events: [],
  };
}

export function run_simulation(sim: Simulation): void {
  while (true) {
    const events_todo = sim.events.filter((event) =>
      (event.scheduled_at >= sim.current_time) &&
      (event.status === EventState.Scheduled)
    ).sort((a, b) => b.scheduled_at - a.scheduled_at);

    const event = events_todo.pop();

    if (!event) {
      break;
    }

    sim.current_time = event.scheduled_at;
    const finished = handle_event(sim, event);
    sim.events = [finished, ...sim.events];
  }
}

export function create_event(
  sim: Simulation,
  scheduled_at: number,
  callback?: Process,
): Event {
  return {
    id: crypto.randomUUID(),
    status: EventState.Fired,
    fired_at: sim.current_time,
    scheduled_at,
    callback: callback ?? function* () {
      yield;
    },
  };
}

export function schedule_event(sim: Simulation, event: Event): Event[] {
  return [{ ...event, status: EventState.Scheduled }, ...sim.events];
}

export function handle_event(sim: Simulation, event: Event): Event {
  const generator = event.callback(sim, event);
  const { value, done } = generator.next();

  sim.events = sim.events.filter((previous) => previous.id !== event.id);

  if (!done && value) {
    const scheduled_at = value.scheduled_at > sim.current_time
      ? value.scheduled_at
      : sim.current_time;

    sim.events = schedule_event(sim, {
      ...event,
      status: EventState.Scheduled,
      scheduled_at: scheduled_at,
      callback: function* (sim: Simulation, event: Event) {
        yield* generator;
      },
    });
  }

  return {
    ...event,
    finished_at: sim.current_time,
    status: EventState.Finished,
  };
}

export function* timeout(
  sim: Simulation,
  duration: number,
  callback?: Process,
): Generator<Event | void, void, void> {
  const timeout_event = create_event(
    sim,
    sim.current_time + duration,
    callback ?? function* () {
      yield;
    },
  );

  sim.events = schedule_event(sim, timeout_event);

  yield timeout_event;
}
