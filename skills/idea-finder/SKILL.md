---
name: idea-finder
description: Orchestrate evidence-native demand research through the standalone idea-finder CLI. Use when a user asks Codex or another compatible agent to discover or investigate demand, inspect stored evidence, compare qualitative and quantitative signals, handle incomplete research, calibrate an Opportunity, plan or record validation work, or configure recurring monitoring.
---

# Idea Finder

Turn natural-language research requests into safe calls to the canonical `idea-finder` CLI. Keep business rules inside the CLI. Never recreate persistence, scoring, admission, calibration, or monitoring logic in agent code.

Read [references/cli-workflows.md](references/cli-workflows.md) for installation, exact commands, and response fields.

## Operating contract

1. Run `idea-finder workspace diagnostics --json` before mutating a workspace.
2. Use `--json` for every command. Parse the versioned envelope; do not scrape human output.
3. Reuse returned Brief, ResearchRun, claim, Opportunity, experiment, proposal, and comparison IDs. Never invent IDs.
4. Treat exit code 6 and envelope status `partial` as retained-but-incomplete research, not as total failure.
5. Inspect stored evidence before making a claim. Cite the stored quote, series/observation, ranking reference, or source URL returned by inspect commands.
6. Keep conclusions conditional whenever coverage or evidence is incomplete.
7. Default to live research. Never pass `--fixture` or `--fixture-set` when the user asks for real/live research. Fixtures are only for demos and deterministic tests.
8. Never invent or paste fixture data to fill gaps left by failed, throttled, unauthorized, or zero-result sources.

## Choose sources by claim

- Use HN, V2EX, App Store reviews, Stack Exchange, or explicit user imports for qualitative demand, pain, workarounds, commercial intent, and contradictory evidence.
- Use Google Trends only for search momentum (`IDEA_FINDER_GOOGLE_TRENDS_ENDPOINT`; fail-closed `authorization_required` without it).
- Use GitHub metrics only for developer adoption and supply/competition. Prefer `GITHUB_TOKEN` / `GH_TOKEN` / authenticated `gh`; anonymous mode may throttle.
- Use npm or PyPI downloads only for package adoption; retain the PyPI third-party-data caveat.
- Require explicit authorization for login-gated or restricted sources. Otherwise request a user-provided import. Never bypass login, access controls, robots policy, or source terms.
- Do not treat trend, rank, stars, forks, or downloads alone as validated demand.

## Route the request

### Discover or focus research

Create a Brief when the user has no matching Brief or changes the subject, persona, geography, time window, repository, package, evidence lens, or source plan. Select only sources relevant to the claim. Use `research run` followed by `research inspect` for both qualitative-only and multi-lane research so every summarized claim has stored quote/document/source provenance. Use `export` to render the multi-lane report. Use inbox and Library commands only as additional admission views.

### Inspect evidence

Use `research inspect` for multi-lane claims, provenance, and rejected multi-lane candidates (`summary.candidates`). Use `library inspect <opportunityId> --run <runId>` for an admitted Opportunity and `library rejected --run <runId>` for formal Library admission failures only. Report contradictory evidence beside supporting evidence.

### Handle incomplete work

Name every incomplete source or lane and its structured reason (`failed`, `throttled`, `unauthorized`/`authorization_required`, `zero_results`, coverage gaps). Preserve and cite successful evidence. Label all conclusions conditional. Retry the same ResearchRun ID when the user asks to recover missing sources; do not create a healthy-looking replacement run. Do not retry unauthorized sources until credentials or an import are provided.

### Calibrate and validate

Treat calibration and validation mutations as human decisions. Inspect the Opportunity first, present evidence and uncertainty, and ask for an explicit user decision before calling `board calibrate`, `validation add`, or `validation complete`. Never infer approval from the research result. Use only the action, hypothesis, outcome, summary, and note the user actually chose.

### Monitor

Store manual, daily, or weekly cadence with `monitor schedule`. Let Codex Automation, cron, or another external scheduler call `monitor run`; do not build an internal timer. Cite the persisted evidence changes behind added, heated, cooled, or unchanged results. If coverage is partial, state that cooling was suppressed where inconclusive.

## Write the response

Separate facts from interpretation:

- `Stored evidence:` cite inspect-returned provenance.
- `Inference:` explain reasoning not directly stated by a source.
- `Trend-only lead:` label momentum/adoption/ranking evidence that lacks qualitative demand.
- `Contradictory evidence:` show counter-signals.
- `Partial result:` list incomplete lanes and retained successful lanes.
- `Unresolved uncertainty:` state what still needs research or validation.

Never claim an Opportunity is validated merely because it was admitted, promoted, trending, or scheduled for validation.
