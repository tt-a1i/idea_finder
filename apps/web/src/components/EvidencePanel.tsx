import type { EvidenceItem } from "../api/client.js";

interface EvidencePanelProps {
  readonly opportunityId: string | null;
  readonly evidenceIds: readonly string[];
  readonly evidenceById: Readonly<Record<string, EvidenceItem>>;
}

export function EvidencePanel({
  opportunityId,
  evidenceIds,
  evidenceById,
}: EvidencePanelProps) {
  if (!opportunityId) {
    return (
      <aside className="evidence-panel empty">
        <h3>Evidence</h3>
        <p className="muted">Select an opportunity to inspect linked evidence.</p>
      </aside>
    );
  }

  const items = evidenceIds
    .map((id) => evidenceById[id])
    .filter((item): item is EvidenceItem => item !== undefined);

  return (
    <aside className="evidence-panel">
      <h3>Evidence ({items.length})</h3>
      <div className="evidence-list">
        {items.map((item) => (
          <article key={item.id} className="evidence-card">
            <div className="evidence-meta">
              <span className="tag">{item.strength}</span>
              <span className="tag">{item.supportsClaim}</span>
              <span className="mono">{item.platform}</span>
            </div>
            <blockquote>{item.quoteVerbatim}</blockquote>
            <a href={item.url} target="_blank" rel="noreferrer" className="mono link">
              {item.url}
            </a>
          </article>
        ))}
        {items.length === 0 ? (
          <p className="muted">No evidence items linked.</p>
        ) : null}
      </div>
    </aside>
  );
}
