# Canonical CLI workflows

## Prerequisites and clean installation

Require Node.js 22.5 or newer. From a checked-out release, build and pack the standalone artifact:

```bash
npm install
npm run build
npm pack
npm install -g ./idea-finder-0.0.0.tgz
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R "$(npm root -g)/idea-finder/skills/idea-finder" "${CODEX_HOME:-$HOME/.codex}/skills/idea-finder"
idea-finder workspace diagnostics --json
```

After installation, invoke the executable as `idea-finder` (or the local `.bin` path above). Add `--workspace <dir>` when the user selected a non-default workspace.

## Discovery and focused research

Create a public qualitative-source Brief:

```bash
idea-finder brief create agent-workflows --title "Agent coding workflows" --description "Repeated coordination pain" --lens pain,workaround,commercial_intent,contradictory_evidence --source hn --source stack_exchange --term "agent coding" --term workaround --json
```

App Store discovery also requires `--app-id`. Login-gated evidence must arrive through an explicitly authorized integration or a user-provided import:

```bash
idea-finder brief create imported-interviews --title "Imported interviews" --manual-import "User-provided verbatim note" --json
```

Create a focused multi-lane Brief and run it:

```bash
idea-finder brief create agent-demand --title "Agent demand" --manual-import "This workaround is painful" --google-subject "agent coding" --google-geo US --github-repo owner/repo --npm-package agent-tool --pypi-package agent-tool --from 2026-01-01 --to 2026-01-10 --json
idea-finder research run agent-demand --json
idea-finder research inspect <runId> --json
idea-finder research inspect <runId> --claim <claimId> --json
```

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
```

## Incomplete research and retry

Read `data.sourceStatuses`, `incompleteness.reasons`, and retained claims when status is `partial`. Retry the same run:

```bash
idea-finder research run agent-demand --retry <runId> --json
idea-finder research inspect <runId> --json
```

Do not retry an unauthorized source until the user supplies authorization or an import.

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
