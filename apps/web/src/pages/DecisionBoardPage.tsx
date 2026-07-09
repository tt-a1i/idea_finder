import { useEffect, useState } from "react";

import { api, type Opportunity } from "../api/client.js";

type BoardAction = "promote" | "reject" | "park" | "needs_more_evidence";

export function DecisionBoardPage() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(): Promise<void> {
    setOpportunities(await api.listOpportunities());
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function calibrate(opportunityId: string, action: BoardAction): Promise<void> {
    setBusyId(opportunityId);
    setError(null);
    try {
      await api.calibrate({ opportunityId, action, note: note || null });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Decision Board</h1>
          <p className="muted">Human calibration actions on hypotheses.</p>
        </div>
      </header>

      <div className="panel" style={{ marginBottom: "0.75rem", maxWidth: 480 }}>
        <label>
          Calibration note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Demand</th>
              <th>Persona</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((opp) => (
              <tr key={opp.id}>
                <td>
                  <span className="tag">{opp.status}</span>
                </td>
                <td>{opp.demandStatement}</td>
                <td>{opp.persona}</td>
                <td>
                  <div className="btn-row">
                    {(
                      [
                        ["promote", "Promote"],
                        ["park", "Park"],
                        ["reject", "Reject"],
                        ["needs_more_evidence", "More evidence"],
                      ] as const
                    ).map(([action, label]) => (
                      <button
                        key={action}
                        type="button"
                        className={`btn ${action === "reject" ? "btn-danger" : ""}`}
                        disabled={busyId === opp.id}
                        onClick={() => void calibrate(opp.id, action)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {opportunities.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No opportunities on the board.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
