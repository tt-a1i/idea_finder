# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout**: single-context — one glossary at the repo root, system-wide ADRs under `docs/adr/`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

`CONTEXT-MAP.md` and per-context `src/*/docs/adr/` are **not** used in this repo unless the layout is switched to multi-context later.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md                 ← domain glossary (created lazily)
├── docs/
│   ├── adr/                   ← architecture decision records
│   └── agents/                ← agent/skill configuration (this folder)
├── .scratch/                  ← local issue tracker (see issue-tracker.md)
└── .hive/                     ← Hive orchestration (not read by mattpocock skills)
```

## idea_finder product context (seed)

This repo builds **idea_finder** — an evidence-native demand discovery product: Hunting Brief → signal harvest → Evidence Workbench → calibration → Opportunity Report → validation → monitor. Core objects include `HuntingTask`, `OpportunityTheme`, `EvidenceItem`, and `ResearchRun`. Prefer domain language from `CONTEXT.md` once it exists; until then, use these terms consistently in issues and ADRs.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
