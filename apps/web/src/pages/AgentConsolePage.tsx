import { useEffect, useState } from "react";

import { api, type AgentTask } from "../api/client.js";

function statusClass(status: AgentTask["status"]): string {
  if (status === "blocked" || status === "failed") return "tag tag--danger";
  if (status === "succeeded") return "tag tag--ok";
  if (status === "running") return "tag tag--running";
  return "tag";
}

export function AgentConsolePage() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    setTasks(await api.listAgentTasks());
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const selected = tasks.find((t) => t.id === selectedId) ?? tasks[0] ?? null;

  async function createDemo(kind: "research" | "browser" | "computer", domainWrite = false) {
    setBusy(true);
    setError(null);
    try {
      const opps = await api.listOpportunities();
      const opp = opps[0];
      const task = await api.createAgentTask({
        kind,
        intent: domainWrite
          ? "Demonstrate blocked Opportunity write"
          : "Read-only fake agent run",
        opportunityId: opp?.id ?? null,
        evidenceIds: opp?.evidenceItemIds.slice(0, 2),
        domainWrite,
      });
      const completed = await api.runAgentTask(task.id);
      setSelectedId(completed.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Agent Console</h1>
          <p className="muted">
            Policy-gated invocations via <code>AgentGateway</code> — fake/dry-run only.
          </p>
        </div>
        <div className="btn-row">
          <button type="button" disabled={busy} onClick={() => void createDemo("research")}>
            Run research (fake)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void createDemo("browser", true)}
          >
            Browser domain-write (expect blocked)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void createDemo("computer", true)}
          >
            Computer domain-write (expect blocked)
          </button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="split-layout">
        <div className="panel">
          <h2>Tasks</h2>
          {tasks.length === 0 ? (
            <p className="muted">No agent tasks yet — use the buttons above.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Opportunity</th>
                  <th>Intent</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr
                    key={task.id}
                    className={selected?.id === task.id ? "row-selected" : undefined}
                    onClick={() => setSelectedId(task.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="mono">{task.kind}</td>
                    <td>
                      <span className={statusClass(task.status)}>{task.status}</span>
                    </td>
                    <td className="mono">{task.opportunityId ?? "—"}</td>
                    <td>{task.intent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel evidence-panel">
          <h2>Invocation detail</h2>
          {!selected ? (
            <p className="muted">Select a task to inspect policy and result metadata.</p>
          ) : (
            <div className="evidence-list">
              <p className="mono">{selected.id}</p>
              <p>
                <span className={statusClass(selected.status)}>{selected.status}</span>
                {selected.dryRun ? <span className="tag">dry-run</span> : null}
              </p>
              <p className="muted">Planned effects: {selected.plannedEffects.length}</p>
              {selected.invocations.length === 0 ? (
                <p className="muted">Not run yet.</p>
              ) : (
                selected.invocations.map((inv) => (
                  <div key={inv.invocationId} className="evidence-card">
                    <div className="evidence-meta mono">{inv.invocationId}</div>
                    <p>
                      Policy: {inv.policyAllowed ? "allowed" : "denied"} · Result:{" "}
                      {inv.resultStatus ?? "—"}
                    </p>
                    {inv.policyDenials.length > 0 ? (
                      <ul className="denial-list">
                        {inv.policyDenials.map((d) => (
                          <li key={d.code} className="error">
                            <strong>{d.code}</strong> — {d.reason}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">No policy denials.</p>
                    )}
                    {inv.structured ? (
                      <pre className="mono detail-pre">
                        {JSON.stringify(inv.structured, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
