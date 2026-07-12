# idea_finder

Local-first, Agent-native Broad Demand Discovery CLI + Skill.

## Prerequisites

- Node.js 22.5+

## Five-minute Agent quickstart

```bash
npm install
npm run build
npm pack
npm install -g ./idea-finder-0.0.0.tgz
WORKSPACE="$(pwd)/.idea-finder-workspace"
idea-finder workspace diagnostics --workspace "$WORKSPACE" --init --json
idea-finder plan propose --topic "agent coding workflows" --workspace "$WORKSPACE" --json
idea-finder plan confirm <planId> --mode start_now --slug agent-workflows --workspace "$WORKSPACE" --json
idea-finder research run agent-workflows --workspace "$WORKSPACE" --json
idea-finder export agent-workflows --workspace "$WORKSPACE" --json
```

Natural-language Skill path: `topic → plan propose → human confirmation → broad research → inspect → pain map`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install workspace dependencies |
| `npm run typecheck` | Typecheck all packages (`tsc --build`) |
| `npm run build` | Compile all packages to `dist/` |
| `npm run dev` | Watch mode compile |
| `npm run test` | Run Vitest |
| `npm run lint` | Typecheck + test (Wave 1 gate; no ESLint yet) |
| `npm run release:gate` | Run the deterministic CLI + Skill release gate |
| `npm run test:skill-agent` | Run the live Skill evaluation with an authenticated Codex CLI |
| `npm run test:live-smoke` | Optional live connector smoke (`IDEA_FINDER_LIVE_SMOKE=1`) |

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
