import { useEffect, useState } from "react";

import {
  api,
  type HuntingBrief,
  type Opportunity,
  type WorkspaceState,
} from "../api/client.js";
import { EvidencePanel } from "../components/EvidencePanel.js";

export function OpportunityLibraryPage() {
  const [briefs, setBriefs] = useState<HuntingBrief[]>([]);
  const [selectedBrief, setSelectedBrief] = useState<string>("");
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api.listBriefs(), api.getState()])
      .then(([briefList, workspace]) => {
        setBriefs(briefList);
        setState(workspace);
        if (briefList[0]) {
          setSelectedBrief(briefList[0].slug);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    void api
      .listOpportunities(selectedBrief || undefined)
      .then((items) => {
        setOpportunities(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedBrief]);

  const selected = opportunities.find((item) => item.id === selectedId) ?? null;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Opportunity Library</h1>
          <p className="muted">Evidence-backed hypotheses admitted from drafts.</p>
        </div>
        <label>
          Brief filter
          <select
            value={selectedBrief}
            onChange={(e) => setSelectedBrief(e.target.value)}
          >
            <option value="">All</option>
            {briefs.map((brief) => (
              <option key={brief.id} value={brief.slug}>
                {brief.slug}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="split-layout">
        <div className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Demand</th>
                <th>Confidence</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((opp) => (
                <tr
                  key={opp.id}
                  className={opp.id === selectedId ? "row-selected" : undefined}
                  onClick={() => setSelectedId(opp.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <span className="tag">{opp.status}</span>
                  </td>
                  <td>{opp.demandStatement}</td>
                  <td>{opp.confidence}</td>
                  <td>{opp.evidenceItemIds.length}</td>
                </tr>
              ))}
              {opportunities.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No admitted opportunities yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <EvidencePanel
          opportunityId={selected?.id ?? null}
          evidenceIds={selected?.evidenceItemIds ?? []}
          evidenceById={state?.evidenceById ?? {}}
        />
      </div>
    </div>
  );
}
