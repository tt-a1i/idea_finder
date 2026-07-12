import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_EXIT_CODES } from "../src/cli/contract.js";
import { runCli } from "../src/cli/main.js";
import { resolveWorkspacePaths } from "../src/storage/workspace-store.js";
import { WorkspaceService } from "../src/workspace-service.js";

describe("evidence ingest-fetched CLI", () => {
  const leftovers: string[] = [];
  afterEach(async () => {
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const valid = {
    sourceType: "web_article",
    canonicalUrl: "https://example.com/post/1",
    title: "Real post",
    author: "alice",
    retrievedAt: "2026-07-12T00:00:00.000Z",
    verbatimQuote: "This workaround is painful every Monday.",
    rawSnapshot: "Intro.\nThis workaround is painful every Monday.\nOutro.",
    queryId: "q_1",
    collectionMethod: "browser_open_and_read",
    externalId: "post-1",
  };

  it("ingests idempotently and supports list/inspect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-fetched-"));
    leftovers.push(root);
    const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
    const brief = await service.createBrief({ slug: "fetched", title: "Fetched", description: "d" });
    const run = await service.runResearch(brief.slug, { execution: "new" });
    const file = path.join(root, "evidence.json");
    await writeFile(file, JSON.stringify({ ...valid, huntingTaskId: brief.id }), "utf8");

    const first: string[] = [];
    expect(await runCli(["evidence", "ingest-fetched", "--run", run.run.id, "--json-file", file, "--json"], {
      workspaceDir: root,
      stdout: (line) => first.push(line),
    })).toBe(0);
    const firstData = JSON.parse(first.join("\n")).data;
    expect(firstData.provenance).toBe("agent_fetched");
    expect(firstData.idempotent).toBe(false);

    const second: string[] = [];
    expect(await runCli(["evidence", "ingest-fetched", "--run", run.run.id, "--json-file", file, "--json"], {
      workspaceDir: root,
      stdout: (line) => second.push(line),
    })).toBe(0);
    expect(JSON.parse(second.join("\n")).data.idempotent).toBe(true);

    const listed: string[] = [];
    expect(await runCli(["evidence", "list", "--run", run.run.id, "--fetched-only", "--json"], {
      workspaceDir: root,
      stdout: (line) => listed.push(line),
    })).toBe(0);
    expect(JSON.parse(listed.join("\n")).data.count).toBe(1);

    const inspected: string[] = [];
    expect(await runCli(["evidence", "inspect", firstData.document.id, "--run", run.run.id, "--json"], {
      workspaceDir: root,
      stdout: (line) => inspected.push(line),
    })).toBe(0);
    expect(JSON.parse(inspected.join("\n")).data.provenance).toBe("agent_fetched");
  });

  it("fails closed when required fields are missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-fetched-bad-"));
    leftovers.push(root);
    const service = new WorkspaceService({ paths: resolveWorkspacePaths(root) });
    const brief = await service.createBrief({ slug: "bad", title: "Bad", description: "d" });
    const run = await service.runResearch(brief.slug, { execution: "new" });
    const file = path.join(root, "bad.json");
    await writeFile(file, JSON.stringify({ ...valid, canonicalUrl: "" }), "utf8");
    const out: string[] = [];
    const code = await runCli(["evidence", "ingest-fetched", "--run", run.run.id, "--json-file", file, "--json"], {
      workspaceDir: root,
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(CLI_EXIT_CODES.validation);
    expect(JSON.parse(out.join("\n")).errors[0].code).toBe("evidence.url_required");
  });
});
