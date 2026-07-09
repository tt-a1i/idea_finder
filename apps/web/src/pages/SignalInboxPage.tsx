import { useEffect, useState } from "react";

import { api, type HuntingBrief, type InboxSignalSummary } from "../api/client.js";

export function SignalInboxPage() {
  const [briefs, setBriefs] = useState<HuntingBrief[]>([]);
  const [selectedBrief, setSelectedBrief] = useState<string>("");
  const [runId, setRunId] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxSignalSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listBriefs()
      .then((items) => {
        setBriefs(items);
        if (items[0]) {
          setSelectedBrief(items[0].slug);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!selectedBrief) {
      return;
    }
    void api
      .getInbox(selectedBrief)
      .then((result) => {
        setRunId(result.runId);
        setInbox(result.inbox);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedBrief]);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Signal Inbox</h1>
          <p className="muted">Aggregated raw signals from the latest run per brief.</p>
        </div>
        <label>
          Brief
          <select
            value={selectedBrief}
            onChange={(e) => setSelectedBrief(e.target.value)}
          >
            {briefs.map((brief) => (
              <option key={brief.id} value={brief.slug}>
                {brief.slug}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {runId ? <p className="mono muted">Run: {runId}</p> : null}

      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Signal type</th>
              <th>Count</th>
              <th>Sample quote</th>
            </tr>
          </thead>
          <tbody>
            {inbox.map((row) => (
              <tr key={row.signalType}>
                <td className="mono">{row.signalType}</td>
                <td>{row.count}</td>
                <td>
                  <blockquote style={{ margin: 0 }}>{row.sampleQuote}</blockquote>
                </td>
              </tr>
            ))}
            {inbox.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  No signals — run research for this brief first.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
