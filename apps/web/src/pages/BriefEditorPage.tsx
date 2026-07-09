import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { api, type HuntingBrief } from "../api/client.js";

export function BriefEditorPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const isNew = slug === "new";

  const [brief, setBrief] = useState<HuntingBrief | null>(null);
  const [form, setForm] = useState({
    slug: "",
    title: "",
    description: "",
    lenses: "pain, workaround, wtp",
    sourcesEnabled: "hn, reddit, manual",
    successCriteria: "3+ cross-source corroborated signals",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isNew || !slug) {
      return;
    }
    void api
      .getBrief(slug)
      .then((loaded) => {
        setBrief(loaded);
        setForm({
          slug: loaded.slug,
          title: loaded.title,
          description: loaded.description,
          lenses: loaded.lenses.join(", "),
          sourcesEnabled: loaded.sourcesEnabled.join(", "),
          successCriteria: loaded.successCriteria,
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [isNew, slug]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!isNew) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await api.createBrief({
        slug: form.slug.trim(),
        title: form.title.trim(),
        description: form.description.trim(),
        lenses: splitCsv(form.lenses),
        sourcesEnabled: splitCsv(form.sourcesEnabled),
        successCriteria: form.successCriteria.trim(),
      });
      navigate(`/briefs/${created.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">{isNew ? "New brief" : `Brief: ${slug}`}</h1>
          <p className="muted">
            {isNew
              ? "Create a hunting brief for the next research run."
              : "Read-only view — edit flow deferred."}
          </p>
        </div>
        <Link className="btn" to="/briefs">
          Back to list
        </Link>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <form className="panel form-grid" onSubmit={(event) => void submit(event)}>
        <label>
          Slug
          <input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            disabled={!isNew}
            required
          />
        </label>
        <label>
          Title
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            disabled={!isNew}
            required
          />
        </label>
        <label>
          Description
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            disabled={!isNew}
            required
          />
        </label>
        <label>
          Lenses (comma-separated)
          <input
            value={form.lenses}
            onChange={(e) => setForm({ ...form, lenses: e.target.value })}
            disabled={!isNew}
          />
        </label>
        <label>
          Sources enabled
          <input
            value={form.sourcesEnabled}
            onChange={(e) => setForm({ ...form, sourcesEnabled: e.target.value })}
            disabled={!isNew}
          />
        </label>
        <label>
          Success criteria
          <input
            value={form.successCriteria}
            onChange={(e) => setForm({ ...form, successCriteria: e.target.value })}
            disabled={!isNew}
          />
        </label>

        {isNew ? (
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Creating…" : "Create brief"}
          </button>
        ) : (
          <p className="muted mono">Created {brief?.createdAt ?? "—"}</p>
        )}
      </form>
    </div>
  );
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
