# @idea-finder/storage

Local-first persistence for single-user runs. Uses Node built-in `node:sqlite` (`DatabaseSync`) and a content-addressed blob directory under `data/blobs/`.

**Requires Node.js >= 22.5** (for `node:sqlite`).

## Quick start

```typescript
import { openLocalStorage } from "@idea-finder/storage";

const storage = openLocalStorage({ dataDir: "./data" });

storage.researchRuns.save({
  id: "run_1",
  huntingTaskId: "task_1",
  status: "pending",
  startedAt: null,
  completedAt: null,
  configHash: "cfg_v1",
  errorMessage: null,
});

const blob = await storage.blobs.put(new TextEncoder().encode("hello"));
const roundTrip = await storage.blobs.get(blob);

storage.close();
```

## Layout

| Path | Purpose |
|------|---------|
| `{dataDir}/idea_finder.db` | SQLite database (schema init is idempotent) |
| `{dataDir}/blobs/{aa}/{bb}/{sha256}` | Content-addressed blob store |

## Repositories

- `researchRuns` — keyed by run id; equal `(huntingTaskId, configHash)` values may belong to distinct intentional scans
- `huntingBriefs`, `researchRunConfigs` — canonical Briefs and effective run configuration snapshots
- `rawDocuments`, `chunks`, `rawSignals`, `evidenceItems`, `opportunityDrafts`, `opportunities`, `calibrationEvents` — run-scoped JSON payloads
- `libraryAdmissionResults`, `sourceStatuses` — admitted/rejected outcomes and source execution state
- `calibrationEvents` — append-only Decision Board history scoped by ResearchRun
- `validationExperiments`, `monitorSchedules`, `monitorComparisons`, `agentTasks` — canonical runtime state
- `metricObservations`, `trendSeries`, `trendEvents`, `quantitativeSourceStatuses` — canonical quantitative observations, derived momentum, provenance, and source health; stable identities and references fail closed
- `normalizationContexts` — Google Trends relative-scale context; geography, window, comparison set, and partial-bucket identity are preserved so incompatible 0–100 values cannot be combined

Package observations and series index ecosystem, canonical package name, and
bucket window explicitly. This keeps same-named npm and PyPI packages separate
and makes PyPI normalization aliases idempotent.
- `pipelineSteps` — completed step markers for idempotent orchestration
- `jobs` — idempotent enqueue by `idempotencyKey`
- `audit` — append-only audit events
- `blobs` — SHA-256 content-addressed local filesystem store

## Schema

Tables are created with `CREATE TABLE IF NOT EXISTS` on `openLocalStorage()`. Re-opening the same `dataDir` is safe.
