import { useEffect, useState } from "react";

import { api, type SettingsInfo, type WebHarvestMode, type WebRunnerMode } from "../api/client.js";

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [health, setHealth] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load(): Promise<void> {
    const [info, status] = await Promise.all([api.getSettings(), api.health()]);
    setSettings(info);
    setHealth(status.ok);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function updateRunnerMode(runnerMode: WebRunnerMode): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setSettings(await api.updateSettings({ runnerMode }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function updateHarvestMode(harvestMode: WebHarvestMode): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setSettings(await api.updateSettings({ harvestMode }));
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
          <h1 className="page-title">Settings</h1>
          <p className="muted">Local workspace configuration (no auth/billing).</p>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <div className="panel form-grid">
        <div>
          <div className="muted">API health</div>
          <div className="mono">{health === null ? "…" : health ? "ok" : "down"}</div>
        </div>
        <div>
          <div className="muted">Workspace directory</div>
          <div className="mono">{settings?.workspaceDir ?? "—"}</div>
        </div>
        <label>
          Runner mode
          <select
            value={settings?.runnerMode ?? "orchestration"}
            disabled={saving}
            onChange={(e) => void updateRunnerMode(e.target.value as WebRunnerMode)}
          >
            <option value="orchestration">orchestration (local pipeline)</option>
            <option value="fixture">fixture (instant demo)</option>
          </select>
        </label>
        <label>
          Harvest mode
          <select
            value={settings?.harvestMode ?? "manual"}
            disabled={saving || settings?.runnerMode === "fixture"}
            onChange={(e) => void updateHarvestMode(e.target.value as WebHarvestMode)}
          >
            <option value="manual">manual (safe, no live network)</option>
            <option value="l0">l0 (public APIs/RSS)</option>
          </select>
        </label>
        <div>
          <div className="muted">Schema version</div>
          <div className="mono">{settings?.version ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}
