# idea_finder

Local-first, Agent-native Broad Demand Discovery CLI + Skill.

This is a **local-only personal tool**. Local artifact version: **`0.1.0-rc.1`** (not a public release). Install only by packing this repository and installing the generated tarball — there is no public npm registry install path. The root package sets `private: true` so npm refuses accidental publish, and `license: "UNLICENSED"` so no license is granted to others. There is no plan for npm publish, dist-tag, git release tag, or GitHub Release. Changing GitHub repository visibility is a separate remote decision and is not part of this packaging setup.

## Prerequisites

- Node.js 22.5+

## Five-minute Agent quickstart

Local pack/install from this repository (captures the exact tarball name from `npm pack`, so version bumps stay usable):

```bash
npm install
npm run build
TARBALL="$(npm pack --silent)"
npm install -g "./$TARBALL"
WORKSPACE="$(pwd)/.idea-finder-workspace"
idea-finder workspace diagnostics --workspace "$WORKSPACE" --init --json
idea-finder plan propose --topic "agent coding workflows" --workspace "$WORKSPACE" --json
idea-finder plan confirm <planId> --mode start_now --slug agent-workflows --workspace "$WORKSPACE" --json
idea-finder research run agent-workflows --workspace "$WORKSPACE" --json
idea-finder export agent-workflows --workspace "$WORKSPACE" --json
```

Do **not** run `npm install -g idea-finder` from the registry — that path is not supported. Use the local pack workflow above.

Natural-language Skill path: `topic → plan propose → human confirmation → broad research → inspect → pain map`.
## Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install workspace dependencies |
| `npm run typecheck` | Typecheck all packages (`tsc --build`) |
| `npm run build` | Compile all packages to `dist/` |
| `npm run dev` | Watch mode compile |
| `npm run test` | Run Vitest (deterministic; live suites skipped unless opted in) |
| `npm run lint` | Typecheck + test (Wave 1 gate; no ESLint yet) |
| `npm run release:gate` | Deterministic typecheck + fixture suite (no live network) |
| `npm run release:smoke` | Clean-consumer pack/install CLI + Skill contract smoke |
| `npm run test:live-smoke` | Opt-in HN Algolia probe (`IDEA_FINDER_LIVE_SMOKE=1`) |
| `npm run test:live-acceptance` | Opt-in HN + GitHub Issues dual-source acceptance |
| `npm run test:skill-agent` | Live Skill eval (authenticated Codex CLI or `OPENAI_API_KEY`) |

### Verification layers

- **Deterministic gate** (`npm run release:gate`): offline fixtures only; safe for every PR.
- **Live HN smoke** (`npm run test:live-smoke`): single real Algolia hit; never part of the gate.
- **Live dual-source acceptance** (`npm run test:live-acceptance`): real HN + GitHub Issues research through propose → confirm → run → export/ledger. Needs network and a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`). Optional redacted summary via `IDEA_FINDER_LIVE_ACCEPTANCE_OUT=<dir>`. Manual workflow: `live-dual-source-acceptance`.
- **Live Skill Agent eval** (`npm run test:skill-agent`): real Codex CLI against the packed Skill. Manual workflow: `live-skill-agent-eval`.

## Package layout

Architectural seams under `packages/`:

| Package | Role |
|---------|------|
| `@idea-finder/core` | Domain types + shared ports |
| `@idea-finder/storage` | Canonical SQLite + blob/queue/audit |
| `@idea-finder/llm` | LLM provider port |
| `@idea-finder/agents` | Agent connector port, PolicyEngine, AgentGateway |
| `@idea-finder/connectors` | Source connectors (HN, V2EX, SE, App Store, GitHub Issues/metrics, …) |
| `@idea-finder/harvest` | Harvest pipeline |
| `@idea-finder/intelligence` | Clustering / evidence builders |
| `@idea-finder/orchestration` | ResearchRun orchestration |
| `@idea-finder/workspace` | Standalone CLI + workspace service |

Default workspace is a stable user-data directory (or `IDEA_FINDER_WORKSPACE` / `--workspace`). Always pass an explicit `--workspace` from Agent workflows.

## Agent gateway (Wave 3)

`@idea-finder/agents` exposes typed `AgentRequest`/`AgentResult` contracts, a fail-closed `PolicyEngine`, and `AgentGateway` that records invocation metadata without writing domain objects.

**Execution today:** workspace `AgentTaskRunner` and CLI/Web surfaces invoke `FakeAgent` / `ScriptedAgent` only. Real browser, computer, and coding connectors are future work.

**Policy vs runtime:** `PolicyEngine` validates **declared** `plannedEffects` before invoke (paths, URLs, domain writes). When real browser/computer connectors land, they still need runtime sandboxing and a kill-switch — pre-flight policy is necessary but not sufficient on its own.
