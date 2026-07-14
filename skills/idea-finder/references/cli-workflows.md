# Canonical CLI workflows

## Prerequisites and clean installation

Require Node.js 22.5+. `idea-finder` is a local-only personal tool. Local artifact version `0.1.0-rc.1` is not a public release. Install only by packing this repository and installing the generated tarball — there is no public npm registry install path. The root package sets `private: true` to prevent accidental npm publish, and `license: "UNLICENSED"` so no license is granted to others. There is no plan for npm publish, dist-tag, git release tag, or GitHub Release. From this repository checkout, build and pack the standalone artifact:

```bash
npm install
npm run build
TARBALL="$(npm pack --silent)"
npm install -g "./$TARBALL"
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R "$(npm root -g)/idea-finder/skills/idea-finder" "${CODEX_HOME:-$HOME/.codex}/skills/idea-finder"
idea-finder workspace diagnostics --workspace "$HOME/Library/Application Support/idea-finder/workspace" --json
# Missing workspace: pass --init once, or let the first mutation create it.
# idea-finder workspace diagnostics --workspace <dir> --init --json
```

After installation, invoke the executable as `idea-finder` (or the local `.bin` path above). **Always** pass `--workspace <absolute-dir>` from Agent workflows. The CLI default (when the flag is omitted) is a stable user data directory—macOS `~/Library/Application Support/idea-finder/workspace`, otherwise `~/.local/share/idea-finder/workspace`—or `IDEA_FINDER_WORKSPACE` when set. It is not a cwd-relative `data/workspace` path. `workspace diagnostics` does not create directories unless `--init` is passed.

## Discovery and focused research

idea-finder plan propose --topic "Agent coding workflows" --workspace <dir> --json
# Wait for user confirmation, then:
idea-finder plan confirm <planId> --mode explicit --slug agent-workflows --workspace <dir> --json
idea-finder research run agent-workflows --json
idea-finder research inspect <runId> --json
idea-finder export agent-workflows --json
```

Create a public qualitative-source Brief (no agent-invented manual imports) only after confirmation, or when continuing an existing Brief:

```bash
idea-finder brief create agent-workflows --title "Agent coding workflows" --description "Repeated coordination pain" --lens pain,workaround,commercial_intent,contradictory_evidence --source hn --source stack_exchange --term "agent coding" --term workaround --json
```

Login-gated evidence must arrive through an explicitly authorized integration or a **user-provided verbatim** import. Only pass `--manual-import` when the user supplied the exact text (or authorized an existing file/note). Example using user-provided verbatim text:

```bash
idea-finder brief create imported-interviews --title "Imported interviews" --manual-import "User-provided verbatim note" --json
```

Create a focused multi-lane Brief. The `--manual-import` below is **user-provided verbatim text** (or a deterministic test fixture labeled as such)—never agent-authored filler:

```bash
idea-finder brief create agent-demand --title "Agent demand" --manual-import "This workaround is painful" --google-subject "agent coding" --google-geo US --github-repo owner/repo --npm-package agent-tool --pypi-package agent-tool --from 2026-01-01 --to 2026-01-10 --json
# Live research — never add --fixture / --fixture-set for real studies.
idea-finder research run agent-demand --json
idea-finder research inspect <runId> --json
idea-finder research inspect <runId> --claim <claimId> --json
idea-finder export agent-demand --json
```

GitHub quantitative collection reuses `GITHUB_TOKEN`, then `GH_TOKEN`, then
`gh auth token` when available. Prefer setting `GITHUB_TOKEN` in the agent
environment. Tokens must never appear in argv, logs, or reports. Anonymous
access may return `throttled`.

Google Trends production collection requires an explicitly authorized adapter
because Google's official API is limited-access. Configure an approved API or
public-dataset bridge without placing credentials on the command line:

```bash
export IDEA_FINDER_GOOGLE_TRENDS_ENDPOINT=https://trends-adapter.example/query
export IDEA_FINDER_GOOGLE_TRENDS_TOKEN='...'
idea-finder trends collect google "agent coding" --geo US --from 2026-01-01T00:00:00Z --to 2026-01-10T00:00:00Z --json
idea-finder research run agent-demand --json
```

The adapter receives the provider-neutral query as JSON and returns a `payload`
with `rows`, `comparisonSet`, and `anchor`. If no authorized adapter is
configured, preserve the CLI's fail-closed `authorization_required` result.

For qualitative-only discovery, use the same inspectable research report path:

```bash
idea-finder research run agent-workflows --json
idea-finder research inspect <runId> --json
idea-finder inbox --brief agent-workflows --json
idea-finder library --brief agent-workflows --json
idea-finder library rejected --run <runId> --json
```

`library rejected` lists formal Library admission failures. Multi-lane
trend/star/ranking/download-only rejects live on `research inspect` /
`export` under `summary.candidates` and must not be treated as Library entries.

Run each CLI command as its own invocation. Do not chain exploratory `ls` or path probes with `&&` before the first `workspace diagnostics` call. Always pass `--workspace <dir>`; diagnostics alone will not create a missing directory—use `--init` or the first mutation.
## Incomplete research and retry

Read `data.sourceStatuses`, `incompleteness.reasons`, and retained claims when status is `partial` (exit 6). Successful lanes remain inspectable. Retry the same run:

```bash
idea-finder research run agent-demand --retry <runId> --json
idea-finder research inspect <runId> --json
```

Do not retry an unauthorized source until the user supplies authorization or an import. Do not use `--fixture` / `--fixture-set` to paper over live failures. Do not invent `--manual-import` text when public sources fail; keep the empty or partial result and report unresolved uncertainty.

## Opportunity and validation boundary

Inspect before requesting a human decision:

```bash
idea-finder library inspect <opportunityId> --run <runId> --json
```

Only after explicit approval, use the selected mutation:

```bash
idea-finder board calibrate <opportunityId> --run <runId> --action <promote|reject|park|needs_more_evidence> --note "<user note>" --json
idea-finder validation add <opportunityId> --run <runId> --type <mom_test|landing|community_test|spike|custom> --hypothesis "<user-approved hypothesis>" --json
idea-finder validation complete <experimentId> --outcome <validated|invalidated|inconclusive|blocked> --summary "<human-provided summary>" --json
```

## Monitoring from an external scheduler

```bash
idea-finder monitor schedule agent-demand --cadence weekly --min-cross-source-growth 1 --min-strong-pain-growth 1 --min-commercial-growth 1 --min-cooling-loss 2 --json
idea-finder monitor run agent-demand --json
```

The first invocation establishes a baseline. Later invocations create distinct ResearchRuns and return a persisted comparison with coverage, evidence changes, notification reasons, and cooling suppression.

## Five-minute Agent quickstart

```bash
TARBALL="$(npm pack --silent)" && npm install -g "./$TARBALL"
WORKSPACE="$PWD/idea-finder-workspace"
idea-finder workspace diagnostics --workspace "$WORKSPACE" --init --json
idea-finder plan propose --topic "agent coding workflows" --language en --language zh --workspace "$WORKSPACE" --json
# Wait for user confirmation, then:
idea-finder plan confirm <planId> --mode start_now --slug agent-workflows --workspace "$WORKSPACE" --json
idea-finder research run agent-workflows --workspace "$WORKSPACE" --json
idea-finder research inspect <runId> --workspace "$WORKSPACE" --json
idea-finder export agent-workflows --workspace "$WORKSPACE" --json
```

Partial source failures remain inspectable (`status: partial`, exit 6). Import Agent-opened evidence with:

```bash
idea-finder evidence ingest-fetched --run <runId> --json-file ./fetched.json --workspace "$WORKSPACE" --json
```

`fetched.json` must include sourceType, canonicalUrl, retrievedAt, verbatimQuote, rawSnapshot or replayRef, queryId, collectionMethod, and externalId.
