export interface Simulation {
  current_time: number;
  events: Event[];
}

export enum EventState {
  Fired = "Fired",
  Scheduled = "Scheduled",
  Finished = "Finished",
}

export type Process = (
  sim: Simulation,
  event: Event,
) => Generator<Event | void, void, void>;

export interface Event {
  id: string;
  status: EventState;
  fired_at: number;
  scheduled_at: number;
  finished_at?: number;
  callback: Process;
}

export function initialize_simulation(): Simulation {
  return {
    current_time: 0,
    events: [],
  };
}

export function run_simulation(sim: Simulation): void {
  while (true) {
    const current_time = sim.current_time;

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
  callback: Process,
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
  return [{ ...event, status: EventState.Scheduled }, ...sim.events];
}

export function handle_event(sim: Simulation, event: Event): Event {
  const next_event = event.callback(sim, event).next();

  if (next_event.value && !next_event.done) {
    sim.events = schedule_event(sim, next_event.value);
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
  callback: Process | void,
): Generator<Event | void, void, void> {
  const empty_callback = function* () {
    yield;
  };

  const timeout_callback = callback ? callback : empty_callback;

  const timeout_event = create_event(
    sim,
    sim.current_time + duration,
    timeout_callback,
  );

  sim.events = schedule_event(sim, timeout_event);

  yield timeout_event;
}

if (import.meta.main) {
  // Initialization simulation
  const sim = initialize_simulation();

  const hi: Process = function* (
    sim: Simulation,
    event: Event,
  ): Generator<Event | void, void, void> {
    // Print hi
    console.log(`[${sim.current_time}] hi`);
    yield;
  };

  const bye: Process = function* (
    sim: Simulation,
    event: Event,
  ): Generator<Event | void, void, void> {
    const cb = function* (
      sim: Simulation,
      event: Event,
    ): Generator<Event | void, void, void> {
      // Print bye
      console.log(`[${sim.current_time}] bye`);

      yield* timeout(sim, 3);
      yield;

      return;
    };
    // Sleep for 15 steps and execute callback
    yield* timeout(sim, 15, cb);

    // BUG
    console.log(sim.current_time);
    console.log("yo");
  };

  const e1 = create_event(sim, 10, hi);
  sim.events = schedule_event(sim, e1);

  const e2 = create_event(sim, 20, bye);
  sim.events = schedule_event(sim, e2);

  const e3 = create_event(sim, 33, hi);
  sim.events = schedule_event(sim, e3);

  const e4 = create_event(sim, 50, hi);
  sim.events = schedule_event(sim, e4);

  run_simulation(sim);

  console.log(`Simulation ended at ${sim.current_time}`);
  console.log("Events:", JSON.stringify(sim.events, null, 2));
}
