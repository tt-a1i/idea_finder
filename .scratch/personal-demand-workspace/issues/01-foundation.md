Status: ready-for-agent

# Wave 1 Foundation — ResearchRun → Opportunity Library → Decision Board

## Parent

`.scratch/personal-demand-workspace/PRD.md`

## What to build

Deliver the **Wave 1 foundation** for a local-first personal demand workspace (not SaaS). Prove the accepted testing seam end-to-end in code:

```
ResearchRun → Opportunity Library → Decision Board
```

### 1. Monorepo scaffold

- Root npm workspaces + `@idea-finder/core` package (TypeScript ESM, Vitest, `tsc --build`)
- Root scripts: `typecheck`, `test`, `build`

### 2. Evidence-native domain model

Types and pure validation for:

- `ResearchRun` (id, huntingTaskId, status, configHash, startedAt, completedAt)
- `RawDocument`, `Chunk`, `RawSignal`, `EvidenceItem`
- `OpportunityDraft`, `Opportunity`, `CalibrationEvent`
- Enums: `ResearchRunStatus`, `OpportunityStatus`, `CalibrationAction`, `ActorKind`, `SignalType`, etc.

Validation invariants (must gate library admission):

- No opportunity without evidence refs
- `quote_verbatim` exact substring of chunk text
- hypothesis: ≥3 non-disconfirming evidence
- promoted: corroboration rule (≥2 documents OR WTP/workaround)
- browser_agent cannot write opportunities; browser evidence needs agentRunId

### 3. In-memory library & board services

Pure functions (no I/O):

- **`admitToLibrary(drafts, evidenceById, …)`** — validates drafts; returns `{ admitted: Opportunity[], rejected: { draft, issues }[] }`
- **`applyCalibration(opportunity, action, note, actor)`** — returns updated Opportunity + CalibrationEvent; enforces promote gates

### 4. Accepted testing seam (integration test)

Vitest scenario **`research-run-to-board.spec.ts`** (name flexible):

```
Fixture: completed ResearchRun + evidence map + 2 OpportunityDrafts
  (one valid ≥3 evidence, one under-evidenced)

→ admitToLibrary: valid → hypothesis in library; invalid → rejected with codes

→ applyCalibration PROMOTE on valid: status promoted + CalibrationEvent

→ applyCalibration REJECT on another: status rejected + note preserved

→ applyCalibration PARK: status unchanged or parked per domain rule + event logged
```

This test is the **definition of done** for Wave 1 foundation. Unit tests for individual validators are supporting only.

## Acceptance criteria

- [ ] `@idea-finder/core` exports domain types, validation, library/board helpers
- [ ] Integration test passes: ResearchRun fixture → library admission → board calibration
- [ ] Under-evidenced draft never enters library (test proves rejection)
- [ ] Promote on under-corroborated opportunity fails validation (test proves gate)
- [ ] `npm run typecheck` and `npm test` pass from repo root
- [ ] No UI, DB, connectors, LLM, or agent gateway code
- [ ] No commercialization features (auth, billing, multi-tenant)

## Blocked by

None — can start immediately

## User stories covered

US 1–11 from PRD (Wave 1 core loop + tooling)

## Out of scope (this issue)

- Signal Inbox UI, Brief editor, live harvest connectors
- Persistence layer, blob snapshots, job queue
- Agent dispatch, validation hub, monitor diff
- SaaS/commercialization surfaces

## Comments

Single tracer bullet for Wave 1. Maps to `.hive/tasks.md` Implementation Wave 1 items: scaffold, domain model, integrate, typecheck/test.
