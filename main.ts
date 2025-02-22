export interface Simulation {
  current_time: number;
  events: Event[];
}

export enum EventState {
  Fired = "Fired",
  Scheduled = "Scheduled",
  Finished = "Finished",
}

export interface Event {
  id: string;
  status: EventState;
  fired_at: number;
  scheduled_at: number;
  finished_at?: number;
  callback: (
    sim: Simulation,
    event: Event,
  ) => Generator<Event | void, void, void>;
}

export function initialize_simulation(): Simulation {
  return {
    current_time: 0,
    events: [],
  };
}

export function run_simulation(sim: Simulation): void {
  const current_time = sim.current_time;

  while (true) {
    const events_todo = sim.events.filter((event) =>
      (event.scheduled_at >= current_time) &&
      (event.status === EventState.Scheduled)
    ).sort((a, b) => b.scheduled_at - a.scheduled_at);

    console.log(
      `[${sim.current_time}] Events: ${events_todo.length} left to handle`,
    );

    const event = events_todo.pop();

    if (!event) {
      break;
    }

    sim.current_time = event.scheduled_at;
    const finished = handle_event(sim, event);
    sim.events = [finished, ...sim.events.filter((e) => e !== event)];
  }
}

export function create_event(
  sim: Simulation,
  scheduled_at: number,
  callback: (
    sim: Simulation,
    event: Event,
  ) => Generator<Event | void, void, void>,
): Event {
  return {
    id: crypto.randomUUID(),
    status: EventState.Fired,
    fired_at: sim.current_time,
    scheduled_at,
    callback,
  };
}

export function schedule_event(sim: Simulation, event: Event): Event[] {
  return [...sim.events, { ...event, status: EventState.Scheduled }];
}

export function handle_event(sim: Simulation, event: Event): Event {
  const next_event = event.callback(sim, event).next();

  if (next_event.value) {
    sim.events = schedule_event(sim, next_event.value);
  }

  return {
    ...event,
    finished_at: sim.current_time,
    status: EventState.Finished,
  };
}

export function* timeout(sim: Simulation, duration: number): Generator<Event | void, void, void> {
  yield create_event(
    sim,
    sim.current_time + duration,
    function* (
      sim: Simulation,
      event: Event,
    ): Generator<Event | void, void, void> {
      yield void 0;
    },
  );
}

if (import.meta.main) {
  // Initialization simulation
  const sim = initialize_simulation();

  const hi = function* (
    sim: Simulation,
    event: Event,
  ): Generator<Event | void, void, void> {
    console.log(`[${sim.current_time}] hi`);
    yield void 0;
  };

  const bye = function* (
    sim: Simulation,
    event: Event,
  ): Generator<Event | void, void, void> {
    yield timeout(sim, 15).next().value;
    console.log(`[${sim.current_time}] bye`);
    yield;
  };

  // Schedule an event at timestamp 10
  const e1 = create_event(sim, 10, hi);
  sim.events = schedule_event(sim, e1);

  // Simulation ends when the end event has been handled
  const e2 = create_event(sim, 20, bye);
  sim.events = schedule_event(sim, e2);

  // ...
  const e3 = create_event(sim, 33, hi);
  sim.events = schedule_event(sim, e3);
  run_simulation(sim);

  console.log(`Simulation ended at ${sim.current_time}`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
