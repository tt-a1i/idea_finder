# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

> **Hive 编排**（`.hive/tasks.md`、`team` CLI）与 engineering skills 的 issue 追踪是两套系统。Hive 管多成员任务；`to-issues`、`triage`、`to-prd`、`qa` 等 skills 读写本文件描述的 `.scratch/` 约定。

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

### Issue file skeleton

```markdown
# <title>

Status: needs-triage

## Description

...

## Comments
```

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Pull requests as a triage surface

Not applicable — local markdown tracker has no PR workflow.
