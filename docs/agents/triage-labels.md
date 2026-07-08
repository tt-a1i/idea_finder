# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the strings used in this repo's issue tracker.

For the **local markdown** tracker, each issue file carries triage state in a top-level `Status:` line (not GitHub/GitLab labels).

| Role in mattpocock/skills | `Status:` value in issue files | Meaning |
| ------------------------- | ------------------------------ | ------- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), set `Status:` to the corresponding value from this table.

Edit the right-hand column if you adopt different vocabulary later — keep the left column (canonical role names) unchanged so skills stay portable.
