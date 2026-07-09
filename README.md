# idea_finder

Local-first, evidence-native personal demand workspace (implementation in progress).

## Prerequisites

- Node.js 20+

## Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install workspace dependencies |
| `npm run typecheck` | Typecheck all packages (`tsc --build`) |
| `npm run build` | Compile all packages to `dist/` |
| `npm run dev` | Watch mode compile |
| `npm run test` | Run Vitest |
| `npm run lint` | Typecheck + test (Wave 1 gate; no ESLint yet) |

## Package layout

Architectural seams under `packages/`:

| Package | Role |
|---------|------|
| `@idea-finder/core` | Domain types (owned by domain task) + shared ports |
| `@idea-finder/storage` | Blob, queue, audit port interfaces |
| `@idea-finder/llm` | LLM provider port |
| `@idea-finder/agents` | Agent connector port, PolicyEngine, AgentGateway |
| `@idea-finder/connectors` | Source connector port |
| `@idea-finder/harvest` | Ingest pipeline placeholder |
| `@idea-finder/intelligence` | Embed/cluster/extract placeholder |
| `@idea-finder/orchestration` | Run DAG / scheduling placeholder |

Runtime data lives under `data/` (gitignored).

## Agent gateway (Wave 3)

`@idea-finder/agents` exposes typed `AgentRequest`/`AgentResult` contracts, a fail-closed `PolicyEngine`, and `AgentGateway` that records invocation metadata without writing domain objects.

**Execution today:** workspace `AgentTaskRunner` and CLI/Web surfaces invoke `FakeAgent` / `ScriptedAgent` only. Real browser, computer, and coding connectors are future work.

**Policy vs runtime:** `PolicyEngine` validates **declared** `plannedEffects` before invoke (paths, URLs, domain writes). When real browser/computer connectors land, they still need runtime sandboxing and a kill-switch — pre-flight policy is necessary but not sufficient on its own.
