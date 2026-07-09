# @idea-finder/web

Local web workspace shell for idea_finder. Fixture-backed API over `@idea-finder/workspace`, ready to wire to the real pipeline.

## Prerequisites

- Node.js >= 22.5
- `npm install` from repo root

## Dev

```bash
npm run web:dev
```

Starts:
- API server on `http://127.0.0.1:4177` (`WorkspaceService` with orchestration runner by default)
- Vite UI on `http://127.0.0.1:5173` (proxies `/api` to the API)

Default runner: **orchestration** with **manual** harvest (safe local pipeline, no live network).
Override via Settings UI or env: `WEB_RUNNER_MODE=fixture`, `WEB_HARVEST_MODE=l0`.

## Screens

| Route | Screen |
|-------|--------|
| `/` | Hunting Dashboard |
| `/briefs` | Brief list + run research |
| `/briefs/new` | Brief editor (create) |
| `/inbox` | Signal Inbox |
| `/library` | Opportunity Library + evidence side panel |
| `/board` | Decision Board calibration actions |
| `/validation` | Validation placeholder |
| `/monitor` | Monitor placeholder |
| `/agents` | Agent Console placeholder |
| `/settings` | Local workspace settings |

## Build

```bash
npm run web:build
```

## Stack

- **Vite + React + react-router** — minimal SPA, no UI framework
- **Node HTTP API** — no Express; wraps `WorkspaceService`

Data directory default: `data/web-workspace/` (override with `WEB_WORKSPACE_DIR`).
