---
name: idea-finder
description: Orchestrate evidence-native demand research through the standalone idea-finder CLI. Use when a user asks Codex or another compatible agent to discover or investigate demand, inspect stored evidence, compare qualitative and quantitative signals, handle incomplete research, calibrate an Opportunity, plan or record validation work, or configure recurring monitoring.
---

# Idea Finder

Turn natural-language research requests into safe calls to the canonical `idea-finder` CLI. Keep business rules inside the CLI. Never recreate persistence, scoring, admission, calibration, or monitoring logic in agent code.

Read [references/cli-workflows.md](references/cli-workflows.md) for installation, exact commands, and response fields.

## Operating contract

1. Always pass an explicit `--workspace <absolute-path>` on every command. Do not rely on the process cwd; the CLI default is a stable user data directory (`~/Library/Application Support/idea-finder/workspace` on macOS, `~/.local/share/idea-finder/workspace` elsewhere, overridable with `IDEA_FINDER_WORKSPACE`), not a relative `data/workspace` folder.
2. Run `idea-finder workspace diagnostics --workspace <dir> --json` before mutating a workspace. Diagnostics does not create directories; use `--init` once when you intentionally create a missing workspace, or let the first mutation command create it.
3. Use `--json` for every command. Parse the versioned envelope; do not scrape human output.
4. Reuse returned Brief, ResearchRun, claim, Opportunity, experiment, proposal, and comparison IDs. Never invent IDs.
5. Treat exit code 6 and envelope status `partial` as retained-but-incomplete research, not as total failure.
6. Inspect stored evidence before making a claim. Cite the stored quote, series/observation, ranking reference, or source URL returned by inspect commands.
7. Keep conclusions conditional whenever coverage or evidence is incomplete.
8. Default to live research. Never pass `--fixture` or `--fixture-set` when the user asks for real/live research. Fixtures are only for demos and deterministic tests.
9. Never invent or paste fixture data to fill gaps left by failed, throttled, unauthorized, or zero-result sources.
10. Manual import authenticity: pass `--manual-import` only for text the user explicitly provided in this turn, text from a user-specified file, or existing material the user explicitly authorized for import.
11. Never invent, complete, rewrite, translate, paraphrase, synthesize, or infer manual-import text. Import user-provided text verbatim; do not add pain, workaround, willingness-to-pay, persona, frequency, or source details the user did not supply.
12. Never treat agent reasoning, examples, fixtures, or test prompts as real evidence.
13. When the user provides no manual materials, use real public sources. If those sources fail or are unavailable, keep an empty or `partial` result, list missing sources under `Partial result:` / `Unresolved uncertainty:`, and do not call `--manual-import` to fill the gap.
14. Multiple manual imports from the same user turn do not count as multiple independent sources; they remain one `manual` provenance lane and must not be presented as cross-source corroboration. Without distinct user-provided provenance (such as different URLs), they cannot alone satisfy cross-source Library admission.

## Choose sources by claim

- Use HN, V2EX, App Store reviews, Stack Exchange, or explicit user imports for qualitative demand, pain, workarounds, commercial intent, and contradictory evidence.
- Use Google Trends only for search momentum (`IDEA_FINDER_GOOGLE_TRENDS_ENDPOINT`; fail-closed `authorization_required` without it).
- Use GitHub metrics only for developer adoption and supply/competition. Prefer `GITHUB_TOKEN` / `GH_TOKEN` / authenticated `gh`; anonymous mode may throttle.
- Use npm or PyPI downloads only for package adoption; retain the PyPI third-party-data caveat.
- Require explicit authorization for login-gated or restricted sources. Otherwise request a user-provided import. Never bypass login, access controls, robots policy, or source terms.
- Do not treat trend, rank, stars, forks, or downloads alone as validated demand.

## Route the request

### Discover or focus research

For a broad research topic, **first** propose a SearchPlan and wait for explicit user confirmation before any external search or ResearchRun:

1. `idea-finder plan propose --topic "<topic>" --workspace <dir> --json`
2. Present topic, personas, scenarios, languages, geography, time window, source families, research lenses, and budgets. Ask the user to confirm or adjust.
3. Until the user confirms (or clearly says to start now), do **not** call `research run`, source collection, evidence ingest, calibration, or validation mutations.
4. After confirmation: `idea-finder plan confirm <planId> [--mode explicit|start_now] [--slug <slug>] --workspace <dir> --json`
5. Then `research run` / `research inspect` / `export` using the Brief linked by confirm.

If the user says "直接开始" / "just start", treat that as confirmation with `--mode start_now` and record the default plan parameters via `plan confirm` before researching.

Create a Brief with `brief create` only when the user already has a confirmed plan path or is continuing an existing Brief. Prefer `plan propose → confirm` for new topics so confirmation is auditable via `plan inspect`.

Select only sources relevant to the claim. Use `research run` followed by `research inspect` for both qualitative-only and multi-lane research so every summarized claim has stored quote/document/source provenance. Use `export` to render the multi-lane report. Use inbox and Library commands only as additional admission views.

### Inspect evidence

Use `research inspect` for multi-lane claims, provenance, and rejected multi-lane candidates (`summary.candidates`). Use `library inspect <opportunityId> --run <runId>` for an admitted Opportunity and `library rejected --run <runId>` for formal Library admission failures only. Report contradictory evidence beside supporting evidence.

### Handle incomplete work

Name every incomplete source or lane and its structured reason (`failed`, `throttled`, `unauthorized`/`authorization_required`, `zero_results`, coverage gaps). Preserve and cite successful evidence. Label all conclusions conditional. Retry the same ResearchRun ID when the user asks to recover missing sources; do not create a healthy-looking replacement run. Do not retry unauthorized sources until credentials or an import are provided.

### Calibrate and validate

Treat calibration and validation mutations as human decisions. Inspect the Opportunity first, present evidence and uncertainty, and ask for an explicit user decision before calling `board calibrate`, `validation add`, or `validation complete`. Never infer approval from the research result. Use only the action, hypothesis, outcome, summary, and note the user actually chose.

### Monitor

Store manual, daily, or weekly cadence with `monitor schedule`. Let Codex Automation, cron, or another external scheduler call `monitor run`; do not build an internal timer. Cite the persisted evidence changes behind added, heated, cooled, or unchanged results. If coverage is partial, state that cooling was suppressed where inconclusive.

## Write the response

Prefer a pain-map oriented summary for discovery results (topic, coverage stats, clusters with quotes/URLs). Separate facts from interpretation:

- `Stored evidence:` cite inspect-returned provenance.
- `Inference:` explain reasoning not directly stated by a source.
- `Trend-only lead:` label momentum/adoption/ranking evidence that lacks qualitative demand.
- `Contradictory evidence:` show counter-signals.
- `Partial result:` list incomplete lanes and retained successful lanes.
- `Unresolved uncertainty:` state what still needs research or validation.

Never claim an Opportunity is validated merely because it was admitted, promoted, trending, or scheduled for validation. Never present stars, downloads, ranks, or search heat as validated pain.
