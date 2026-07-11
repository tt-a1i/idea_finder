# CLI — Local Demand Workspace

Command-line workflow for the personal demand workspace (Wave 2 vertical slice). No web UI, no auth, no live LLM.

## Install the standalone CLI

```bash
npm install
npm run build
npm pack
npm install -g ./idea-finder-0.0.0.tgz
idea-finder workspace diagnostics --json
```

The packed root package contains a bundled `idea-finder` executable and does not
require this repository or its npm scripts at runtime. During repository
development, `npm link` exposes the same executable.

## Usage

Default workspace directory: `data/workspace/` (gitignored).

```bash
# Create and list hunting briefs (stored as JSON under data/workspace/briefs/)
npm run cli -- brief create invoicing --title "Solo SaaS invoicing" --description "Stripe-sync pain"
npm run cli -- brief list

# Direct executable after install/link
idea-finder brief list
idea-finder workspace diagnostics

# Run research — fixture mode (default, offline invoicing fixture)
npm run cli -- run invoicing

# Run research — real local pipeline (storage + harvest + intelligence + library admission)
npm run cli -- run invoicing --orchestration
# or: IDEA_FINDER_RUNNER=orchestration npm run cli -- run invoicing

# Signal inbox summary and opportunity library
npm run cli -- inbox --brief invoicing
npm run cli -- library --brief invoicing

# Board calibration
npm run cli -- board calibrate opp_draft-valid --action promote --note "ready to validate"
npm run cli -- board calibrate opp_draft-valid --action park --note "revisit later"

# Export Markdown report with evidence appendix
npm run cli -- export invoicing --out reports/invoicing.md
```

Use `--workspace <dir>` on any command for an alternate data root (useful in tests).

## Machine contract

Every implemented command accepts `--json` (or `--format json`) and emits exactly
one JSON object on stdout. Version `1.0` pins these fields:

```json
{
  "contractVersion": "1.0",
  "command": "brief list",
  "status": "success",
  "data": { "briefs": [] },
  "warnings": [],
  "incompleteness": { "incomplete": false, "reasons": [] },
  "errors": []
}
```

Machine mode never depends on human-readable lines. Stable failure categories and
exit codes are: `usage` (2), `validation` (3), `missing-resource` (4), `policy`
(5), `partial-result` (6), and `internal` (7). Success exits 0. Structured errors
contain `category`, `code`, `message`, and nullable `details`.

## Orchestration mode

`--orchestration` runs the real local pipeline under `<workspace>/pipeline/`:

| Step | Package | Behavior |
| --- | --- | --- |
| Storage | `@idea-finder/storage` | SQLite `idea_finder.db` + blob dir |
| Harvest | `@idea-finder/harvest` | Manual import by default (no network) |
| Intelligence | `@idea-finder/intelligence` | Deterministic rule pipeline |
| Library | `@idea-finder/orchestration` | `ResearchRunOrchestrator` + `admitToLibrary` |

**Harvest modes** (set on brief JSON `queryPlan.harvestMode`):

- `manual` (default) — `manualImports` only; safe for tests and offline use
- `l0` — live L0 connectors (`hn`, `v2ex`, `app_store`, `stack_exchange`) using `sourcesEnabled` and brief lenses

Example brief with explicit manual imports (`briefs/invoicing.json`):

```json
{
  "queryPlan": {
    "harvestMode": "manual",
    "manualImports": [
      { "text": "Painful workaround — invoice from a Google Sheet every month." },
      { "text": "Would pay for lightweight Stripe-sync invoicing." },
      { "text": "QuickBooks works fine for enterprise users." }
    ]
  }
}
```

Fixture mode remains the default CLI path when `--orchestration` is not set.

## Architecture

| Layer | Package | Role |
| --- | --- | --- |
| Domain | `@idea-finder/core` | `admitToLibrary`, `applyCalibration`, validation |
| Workspace | `@idea-finder/workspace` | CLI, JSON workspace state, runners |
| Pipeline | `@idea-finder/orchestration` | `ResearchRunOrchestrator` DAG |
| Bisheng port | `ports/bisheng.ts` | Connector boundary |
| Ganjiang port | `ports/ganjiang.ts` | Workspace JSON state; pipeline uses SQLite |

## Testing

```bash
npm test -- packages/workspace
```

End-to-end coverage: `packages/workspace/test/workspace-e2e.spec.ts` (fixture + orchestration + CLI smoke).
