import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type HuntingBrief, type WorkspaceState } from "../api/client.js";

export function DashboardPage() {
  const [briefs, setBriefs] = useState<HuntingBrief[]>([]);
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [briefList, workspace] = await Promise.all([
          api.listBriefs(),
          api.getState(),
        ]);
        setBriefs(briefList);
        setState(workspace);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const latestRun = state?.runs.at(-1);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Hunting Dashboard</h1>
          <p className="muted">Local fixture-backed workspace overview.</p>
        </div>
        <Link className="btn btn-primary" to="/briefs/new">
          New brief
        </Link>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="grid-3" style={{ marginBottom: "0.75rem" }}>
        <div className="panel stat">
          <div className="muted">Briefs</div>
          <div className="stat-value">{briefs.length}</div>
        </div>
        <div className="panel stat">
          <div className="muted">Runs</div>
          <div className="stat-value">{state?.runs.length ?? 0}</div>
        </div>
        <div className="panel stat">
          <div className="muted">Opportunities</div>
          <div className="stat-value">
            {state ? Object.keys(state.opportunities).length : 0}
          </div>
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <h2>Active briefs</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Title</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {briefs.map((brief) => (
                <tr key={brief.id}>
                  <td className="mono">
                    <Link to={`/briefs/${brief.slug}`}>{brief.slug}</Link>
                  </td>
                  <td>{brief.title}</td>
                  <td>{brief.sourcesEnabled.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Latest run</h2>
          {latestRun ? (
            <dl className="mono">
              <dt className="muted">Run</dt>
              <dd>{latestRun.run.id}</dd>
              <dt className="muted">Status</dt>
              <dd>{latestRun.run.status}</dd>
              <dt className="muted">Admitted</dt>
              <dd>{latestRun.admittedCount}</dd>
              <dt className="muted">Rejected drafts</dt>
              <dd>{latestRun.rejected.length}</dd>
            </dl>
          ) : (
            <p className="muted">No runs yet. Create a brief and run research.</p>
          )}
        </div>
      </section>
    </div>
  );
}
