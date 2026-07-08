/** Injectable time source for replayable runs and tests. */
export interface Clock {
  now(): Date;
}

export interface ClockFactory {
  create(): Clock;
}
