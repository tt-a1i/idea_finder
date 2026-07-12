export type AuditAction =
  | "llm.call"
  | "agent.invoke"
  | "connector.fetch"
  | "policy.denied"
  | "opportunity.promote"
  | "opportunity.reject"
  | "opportunity.park"
  | "opportunity.needs_more_evidence";

export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly action: AuditAction;
  readonly resource: string;
  readonly payload: Record<string, unknown>;
}

export interface AuditLog {
  append(event: Omit<AuditEvent, "id">): Promise<AuditEvent>;
}
