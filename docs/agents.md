# @idea-finder/agents

Safe agent connector contracts, policy, and gateway.

## Execution model

- `AgentGateway` routes requests through `PolicyEngine` and records invocation metadata.
- Workspace `AgentTaskRunner` (CLI/Web) uses **`FakeAgent` / `ScriptedAgent` only** today.
- Real browser, computer, and coding connectors are **not wired yet**.

## Policy vs runtime enforcement

`PolicyEngine` evaluates **declared** `plannedEffects` before invoke:

- filesystem read/write paths
- URL allowlist (origin-aware; see `isUrlAllowed`)
- domain write restrictions (e.g. browser/computer cannot write `Opportunity`)

This is pre-flight, fail-closed authorization. When real browser/computer connectors are added, they must still enforce a **runtime sandbox** and **kill-switch** — declared effects can diverge from actual behavior, so gateway policy alone is not sufficient.

## Testing

```bash
npm test -- packages/agents
```
