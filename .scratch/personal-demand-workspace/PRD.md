Status: ready-for-agent

# Agent-driven Personal Demand Workspace — Wave 1 Foundation PRD

**Feature slug**: `personal-demand-workspace`
**Version**: 1.1 (local tracker)
**Date**: 2026-07-09
**Scope**: Implementation Wave 1 — local-first foundation
**Product goal**: **Local-first personal demand workspace for self-use — not SaaS commercialization**

Full product journey (later waves): Brief → Signal Inbox → **Opportunity Library** → **Decision Board** → Agent Execution → Validation/Monitor

---

## Problem Statement

You want to discover and evaluate real demand opportunities from public signals without drowning in noise, trusting black-box AI rankings, or stitching together spreadsheets, manual searches, and disconnected coding agents.

You are building for **yourself** — a private, local workspace — not a multi-tenant SaaS product. There is no billing, onboarding funnel, or team seat model. The bar is: **good enough to use daily**, with every opportunity backed by auditable evidence.

Today the workflow is fragmented. You need a system where a **ResearchRun** produces evidence-backed opportunities that land in an **Opportunity Library**, and you calibrate them on a **Decision Board** before dispatching agents or starting validation.

Wave 1 establishes that core loop in code and tests — before UI polish, connector sprawl, or agent gateway complexity.

---

## Solution

Build **Wave 1 foundation** as a local-first TypeScript monorepo whose first deliverable proves the seam:

```
ResearchRun → Opportunity Library → Decision Board
```

Concretely:

1. **ResearchRun** — a replayable scan instance (`configHash`, status, stats) that completes with structured harvest output
2. **Opportunity Library** — opportunities with ≥3 evidence items, human-language demand statements, confidence + score breakdown; invalid drafts rejected at the gate
3. **Decision Board** — promote / reject / park / needs-more-evidence actions recorded as `CalibrationEvent`s with optional notes

Underlying this seam: evidence-native domain types, pure validation invariants, monorepo tooling (TypeScript + Vitest), and an **integration test** that walks ResearchRun output → library admission → board calibration in memory (no UI, no DB, no network).

**North star** (full product): weekly ≥1 hand-promoted opportunity entering validation; every conclusion clickable back to source text.

---

## User Stories

### Wave 1 — core loop (ResearchRun → Library → Board)

1. As a builder, I want a completed ResearchRun to produce opportunity candidates with evidence refs, so that scan output becomes library-ready objects.
2. As a builder, I want the Opportunity Library to reject opportunities without sufficient evidence, so that only auditable candidates appear.
3. As a builder, I want to promote an opportunity on the Decision Board, so that it moves to a validated next-step state with a recorded reason.
4. As a builder, I want to reject or park an opportunity with an optional note, so that I can revisit decisions later.
5. As a builder, I want calibration events tied to opportunity ids, so that the board audit trail is reconstructable.
6. As a builder, I want ResearchRun identified by configHash, so that the same brief configuration is replayable and comparable.
7. As a builder, I want quote_verbatim validated as substring of chunk text, so that evidence quotes are trustworthy.
8. As a builder, I want browser agents blocked from writing opportunities directly, so that promotion stays a human or pipeline gate.
9. As a builder, I want `npm test` to exercise the ResearchRun→Library→Board seam, so that the foundation is verifiable in one command.

### Foundation tooling (Wave 1)

10. As a builder, I want a monorepo with typecheck, test, and build scripts, so that later waves integrate cleanly.
11. As a builder, I want domain types shared across packages, so that connectors and UI do not invent parallel models.

### Full product — Brief & Signal Inbox (Wave 2+)

12. As a builder, I want to describe a hunting domain in natural language and save a Hunting Brief, so that the system knows where to look.
13. As a builder, I want a QueryPlan from my brief, so that scans are repeatable.
14. As a builder, I want deduped signal cards in Signal Inbox, so that I am not overwhelmed by raw feeds.
15. As a builder, I want L0 connectors (HN, V2EX, App Store RSS, Stack Exchange) on a schedule, so that discovery is continuous.
16. As a builder, I want manual URL import, so that paywalled sources become evidence.

### Full product — Library & Board UX (Wave 2+)

17. As a builder, I want human-language demand statements on opportunity cards, so that I can judge relevance quickly.
18. As a builder, I want evidence side-by-side with claims, so that I can detect misquotes.
19. As a builder, I want high/medium/low confidence with reasons, not a black-box score.
20. As a builder, I want disconfirming signals and pseudo-demand risks visible, so that I avoid self-deception.

### Full product — Agents & validation (Wave 3+)

21. As a builder, I want to dispatch research/browser/coding/review agents after promote, so that execution continues from the board.
22. As a builder, I want validation experiments tracked per promoted opportunity, so that discovery connects to real checks.
23. As a builder, I want monitor diffs returned to the board, so that weekly rhythm replaces one-off scans.
24. As a builder, I want Markdown export with evidence appendix, so that I can review offline.

### Privacy (all waves)

25. As a builder, I want evidence snapshots stored locally, so that dead links do not erase history.
26. As a builder, I want to delete mistakenly imported PII evidence, so that local data stays under my control.

---

## Implementation Decisions

### Product positioning

- **Local-first, personal use** — single-user mental model; data stays on disk; no tenant isolation required in Wave 1.
- **Not commercialization** — no billing, signup, team seats, white-label, SSO, or public sharing links in scope.
- **Evidence-native** — Opportunity is the product object, not raw posts or keyword alerts.

### Wave 1 deliverables

| Layer | Wave 1 |
|-------|--------|
| Monorepo | Root workspaces + `@idea-finder/core` package |
| Domain | Types + validation for evidence pipeline and board actions |
| Services (in-memory) | ` admitToLibrary()`, `applyCalibration()` — pure functions over domain objects |
| Testing | Integration test: fixture ResearchRun → library → board |
| UI / DB / connectors / LLM / agents | **Out of scope** |

### Domain graph (Wave 1 subset)

```
ResearchRun (completed, configHash)
  → [harvest output: EvidenceItem[], OpportunityDraft[]]
  → Opportunity Library (validated Opportunity hypothesis records)
  → Decision Board (CalibrationEvent: promote | reject | park | needs_more_evidence)
```

### Evidence invariants (enforced before library admission)

| Rule | Detail |
|------|--------|
| Evidence refs | Opportunity must reference existing EvidenceItem ids |
| Quote integrity | quote_verbatim ⊆ chunk.text, non-empty, ≤500 chars |
| Library threshold | ≥3 non-disconfirming evidence to enter library as hypothesis |
| Promote gate | promoted requires ≥2 distinct documents OR WTP/workaround signal |
| Agent boundary | browser_agent cannot create opportunities |

### Opportunity status (Wave 1)

```
draft → hypothesis (library) → promoted | rejected | parked
```

`needs_more_evidence` is a calibration action that keeps hypothesis status but flags follow-up.

### Architecture principles (carry forward)

- Local-first SOT; cloud LLM never sole truth source
- Agent external, orchestration internal (later waves)
- Replayable runs via configHash
- Fail-closed agent policy (stubs in Wave 1)

### Tooling

- TypeScript ESM, Vitest, `tsc --build`
- Package: `@idea-finder/core` — types, validation, in-memory library/board helpers

---

## Testing Decisions

### Accepted testing seam (Wave 1)

**ResearchRun → Opportunity Library → Decision Board**

One integration-level seam — not UI, not live connectors, not LLM:

```
Given: completed ResearchRun fixture (configHash, evidence set, opportunity drafts)
When:  library admission runs with validation
Then:  valid opportunities appear as hypothesis in library; invalid drafts rejected
When:  board calibration (promote / reject / park) applied
Then:  Opportunity status + CalibrationEvent records match expected end state
```

Rationale:

- Proves the **product loop** the workspace exists for — not just isolated validators.
- Still runnable without network/DB/UI — in-memory domain + Vitest.
- Single seam keeps Wave 1 focused; connector and LLM fakes arrive Wave 2+.

### What makes a good test

- Exercise **observable outcomes**: library membership, status transitions, calibration audit trail.
- Use fixture data representing a realistic indie-SaaS pain cluster (invoice/workaround quotes).
- Assert validation rejection paths: under-evidenced draft never enters library.
- Do not assert internal helper names — assert domain results and invariant codes on failure.

### Supporting unit tests

Domain validation functions (quote substring, evidence counts, agent write forbid) may have focused unit tests beneath the integration seam — they support but do not replace the accepted seam.

### Commands (target)

- `npm test` — runs ResearchRun→Library→Board integration + unit invariants
- `npm run typecheck` / `npm run build` — monorepo health

### Prior art

Greenfield; pattern established in Wave 1 becomes template for Wave 2 harvest integration tests.

---

## Out of Scope

### Wave 1

- Workspace UI (web/Tauri), Signal Inbox screens, agent console
- SQLite/Postgres persistence, blob store, job queue
- Live source connectors, embedding, clustering, LLM extract/score
- Agent gateway (research/browser/coding/review)
- Monitor diff, validation hub, report export
- **Commercialization**: billing, multi-tenant, SSO, white-label, public share links
- Changes to `AGENTS.md`, `docs/agents/`, git config

### Full product non-goals

- Keyword monitoring inbox as primary UX
- AI idea waterfalls without evidence
- Black-box 0–100 scores, AI TAM/valuation
- Auto GO/NO-GO verdicts
- Bulk browser crawl without per-URL authorization
- UGC community, 50-platform sprawl

---

## Further Notes

### Implementation issue

See `.scratch/personal-demand-workspace/issues/01-foundation.md`

### Design lineage

Product PRD A, architecture B, evidence C, risk review (司马迁); synthesized for personal local-first scope.

### Open decisions (post–Wave 1)

1. SQLite vs Postgres for solo deploy
2. Web UI vs Tauri shell
3. Reddit API vs manual capture
4. Default coding agent connector
5. When to author `CONTEXT.md` glossary

## Comments

_Published to local markdown tracker. Triage: ready-for-agent._
