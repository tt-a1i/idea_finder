export type LLMAuditAction = "llm.call" | "policy.denied";

export interface LLMAuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly action: LLMAuditAction;
  readonly resource: string;
  readonly payload: Record<string, unknown>;
}

/** Minimal audit hook — compatible with @idea-finder/storage AuditLog.append shape. */
export interface LLMAuditHook {
  append(event: LLMAuditEvent): Promise<void>;
}
