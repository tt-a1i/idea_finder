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
| `@idea-finder/agents` | Agent connector port |
| `@idea-finder/connectors` | Source connector port |
| `@idea-finder/harvest` | Ingest pipeline placeholder |
| `@idea-finder/intelligence` | Embed/cluster/extract placeholder |
| `@idea-finder/orchestration` | Run DAG / scheduling placeholder |

Runtime data lives under `data/` (gitignored).
