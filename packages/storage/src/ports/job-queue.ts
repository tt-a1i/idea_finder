export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface Job<TPayload = Record<string, unknown>> {
  readonly id: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly idempotencyKey: string;
  readonly status: JobStatus;
}

export interface JobQueue {
  enqueue<TPayload>(
    type: string,
    payload: TPayload,
    idempotencyKey: string,
  ): Promise<Job<TPayload>>;
}
