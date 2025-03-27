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
