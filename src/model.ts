export interface Simulation {
  currentTime: number;
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
  firedAt: number;
  scheduledAt: number;
  finishedAt?: number;
  callback: Process;
}
