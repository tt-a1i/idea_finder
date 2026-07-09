import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api, type HuntingBrief, type RunResearchResponse } from "../api/client.js";

export function BriefListPage() {
  const [briefs, setBriefs] = useState<HuntingBrief[]>([]);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof api.getSettings>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunResearchResponse | null>(null);

  async function load(): Promise<void> {
    const [briefList, info] = await Promise.all([api.listBriefs(), api.getSettings()]);
    setBriefs(briefList);
    setSettings(info);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function runBrief(slug: string): Promise<void> {
    setRunning(slug);
    setError(null);
    setLastRun(null);
    try {
      const response = await api.runResearch(slug);
      setLastRun(response);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Hunting Briefs</h1>
          <p className="muted">
            Runner: <span className="mono">{settings?.runnerMode ?? "…"}</span>
            {" · "}
            Harvest: <span className="mono">{settings?.harvestMode ?? "…"}</span>
          </p>
        </div>
        <Link className="btn btn-primary" to="/briefs/new">
          New brief
        </Link>
      </header>

      {error ? <p className="error">{error}</p> : null}

      {lastRun ? (
        <div className="panel" style={{ marginBottom: "0.75rem" }}>
          <div className="mono">
            Run {lastRun.result.run.id} · {lastRun.runnerMode}/{lastRun.harvestMode}
          </div>
          <div>
            Admitted {lastRun.admittedCount} · Rejected {lastRun.rejectedCount}
            {lastRun.error ? (
              <span className="error"> · Error: {lastRun.error}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Title</th>
              <th>Lenses</th>
              <th>Success criteria</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {briefs.map((brief) => (
              <tr key={brief.id}>
                <td className="mono">
                  <Link to={`/briefs/${brief.slug}`}>{brief.slug}</Link>
                </td>
                <td>{brief.title}</td>
                <td>{brief.lenses.join(", ")}</td>
                <td>{brief.successCriteria}</td>
                <td>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={running === brief.slug}
                      onClick={() => void runBrief(brief.slug)}
                    >
                      {running === brief.slug ? "Running…" : "Run research"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
