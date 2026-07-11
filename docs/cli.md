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

The package also ships the companion Codex Skill. For a local clean install:

```bash
npm install -g ./idea-finder-0.0.0.tgz
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R "$(npm root -g)/idea-finder/skills/idea-finder" "${CODEX_HOME:-$HOME/.codex}/skills/idea-finder"
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

# Run a fresh ResearchRun through the real local pipeline (default)
npm run cli -- run invoicing

# Retry or resume a named ResearchRun without changing its identity
npm run cli -- run invoicing --retry run_123
npm run cli -- run invoicing --resume run_123

# Store cadence/notification thresholds, then invoke from cron or Codex Automation
npm run cli -- monitor schedule invoicing --cadence daily --min-cross-source-growth 1 --min-strong-pain-growth 1 --min-commercial-growth 1 --min-cooling-loss 2
npm run cli -- monitor run invoicing --json

# Demonstration fixture data is opt-in only
npm run cli -- run invoicing --fixture

# Deterministic source-outcome fixtures (test/support diagnostics)
npm run cli -- run invoicing --fixture --fixture-source-outcome throttled

# Signal inbox summary and opportunity library
npm run cli -- inbox --brief invoicing
npm run cli -- library --brief invoicing
npm run cli -- library inspect opp_example
npm run cli -- library rejected --run run_example

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
Commands that retain useful results while a required source is missing return
status `partial`, exit 6, and name every incomplete source in
`incompleteness.reasons`. A successful zero-result query remains `success` with
`itemCount: 0` and `reasonCode: zero_results`; it is not reported as unavailable.

## Orchestration mode

Normal `run` execution uses the real local pipeline under `<workspace>/pipeline/`:

| Step | Package | Behavior |
| --- | --- | --- |
| Storage | `@idea-finder/storage` | SQLite `idea_finder.db` + blob dir |
| Harvest | `@idea-finder/harvest` | Manual import by default (no network) |
| Intelligence | `@idea-finder/intelligence` | Deterministic rule pipeline |
| Library | `@idea-finder/orchestration` | `ResearchRunOrchestrator` + `admitToLibrary` |

The same SQLite database is canonical for Briefs, ResearchRuns, effective
configuration, harvested documents, chunks, signals, evidence, drafts,
admission outcomes, source status, and Opportunity Library reads. Existing
`briefs/*.json` and supported fields in `state.json` are imported by one-time,
transactional compatibility migrations; conflicts and orphan references fail
closed before the migration marker is written. After migration, JSON is not read
or written as runtime state. Calibration events are append-only, while validation
experiments, agent tasks, monitor schedules, and monitor comparison metadata use
the same canonical SQLite database.

Harvest execution is checkpointed per source request. Outcomes are one of
`success`, `failure`, `skipped`, `unauthorized`, `throttled`, or `unavailable`,
with a structured reason and optional retry time. Successful source artifacts
are persisted before later sources run. A mixed run continues through
intelligence and Library inspection as `partial`, while its human summary keeps
conclusions conditional. `run --retry <runId>` re-executes only non-successful
source requests and preserves the IDs of already successful artifacts.

GitHub quantitative collection is a separate evidence lane:

```bash
idea-finder trends collect github owner/repository --since 2026-07-01T00:00:00Z --json
idea-finder trends observations --subject owner/repository --metric stars --json
idea-finder trends series --subject owner/repository --metric stars --json
idea-finder trends events --subject owner/repository --metric stars --json
```

It uses the authorized public GitHub REST API (anonymous for public repositories,
or `GITHUB_TOKEN` when set) and records raw/normalized values plus request
provenance and source health in SQLite. Repository stars, forks, contributors,
issue activity, and open-issue counts are classified only as developer-adoption
or supply evidence. They are not `RawSignal`/`EvidenceItem` records and cannot by
themselves satisfy Library admission or promotion.

Google Trends search momentum requires an explicit subject, geography, and time
window. Production collection is fail-closed until an approved Google API or
public-dataset transport is configured; the project does not scrape private
Google web endpoints. Recorded fixtures are opt-in for deterministic tests:

```bash
idea-finder trends collect google "agent coding" --geo US \
  --from 2026-01-01T00:00:00Z --to 2026-01-10T00:00:00Z \
  --granularity day --fixture --fixture-pattern sustained --json
idea-finder trends inspect google "agent coding" --geo US --json
```

The canonical normalization context records the 0–100 relative scale,
geography, window, resolution, comparison set, and partial-bucket state.
Detected outcomes are `spike`, `seasonal`, `sustained_growth`,
`insufficient_history`, or `no_pattern`. Authorization, throttling, unavailable
data, and response drift remain visible source-health states and never become
silent zero observations.

Package adoption uses ecosystem-qualified identity and explicit date windows:

```bash
idea-finder trends collect npm @scope/package --from 2026-01-01 --to 2026-01-31 --json
idea-finder trends collect pypi Requests --from 2026-01-01 --to 2026-01-31 --json
idea-finder trends inspect package --ecosystem pypi --package Requests --json
```

npm collection uses the official public downloads API. PyPI download counts are
collected from the third-party pypistats public API and retain that caveat in
provenance; they are never represented as official PyPI statistics. npm scoped
names and PEP 503-normalized PyPI names remain distinct ecosystem identities.
Counts are normalized to downloads per covered day and remain developer-adoption
evidence only. Rate limits, missing packages, unavailable history, and response
drift are persisted as structured source-health states rather than zero counts.

## Multi-lane research

A Brief can explicitly combine qualitative evidence with Google Trends, GitHub,
npm, and PyPI requests. The report keeps qualitative demand, trend momentum,
supply/competition, commercial intent, and contradictory evidence separate:

```bash
idea-finder brief create agent-demand --title "Agent demand" \
  --manual-import "This workaround is painful" \
  --google-subject "agent coding" --google-geo US \
  --github-repo owner/repo --npm-package agent-tool --pypi-package agent-tool \
  --from 2026-01-01 --to 2026-01-10 --json
idea-finder research run agent-demand --fixture-set representative --json
idea-finder research run agent-demand --retry run_123 --json
idea-finder research inspect <runId> --json
idea-finder research follow-up <runId> --proposal <id> --create agent-demand-followup --json
```

The summary has schema version `1` and no aggregate score. Every claim resolves
to stored quote, observation-series, ranking, or source-URL references. Exact
duplicate text is grouped before corroboration gates are evaluated.
Trend/star/ranking/download-only candidates remain visibly `unvalidated`;
trend anomalies only propose follow-up research and never create an Opportunity.
Qualitative and quantitative requests share one run-scoped source-outcome
ledger. If Google Trends, GitHub, npm, or PyPI is unavailable, `research run`
still persists a partial report containing every completed lane; both `run` and
`inspect` return exit 6 and name incomplete lanes. Retrying the same run skips
successful requests, collects missing lanes, and updates the report without
duplicating persisted snapshots.

Monitoring does not run an internal scheduler. `monitor schedule` stores
`manual`, `daily`, or `weekly` policy and evidence thresholds in canonical
SQLite; an external scheduler calls `monitor run <brief>`. Each invocation
creates a fresh ResearchRun, atomically advances the schedule cursor, and (after
the first baseline) persists an added/heated/cooled/unchanged diff. Entries use
a versioned cross-run semantic key and include added/removed evidence IDs,
platforms, source URLs, and pain/commercial/cross-source deltas. Incomplete
compare coverage is explicit and suppresses otherwise apparent cooling, so a
throttled or unavailable source cannot masquerade as demand loss.

Library entities remain stored per ResearchRun. Library list output includes a
`runId` for every occurrence so `library inspect <id> --run <runId>` forms an
unambiguous list-to-inspect path across Briefs and historical runs. Commands
using only an Opportunity ID select its globally latest occurrence solely for
backward compatibility.

**Harvest modes** (set on brief JSON `queryPlan.harvestMode`):

- `manual` (default) — only explicitly configured `manualImports`; an empty plan yields zero evidence
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

Fixture mode is available only with `--fixture`. Brief descriptions and bundled
demonstration records are never treated as product evidence implicitly.

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
