import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { resolveCliWorkspaceDir, resolveDefaultWorkspaceDir } from "../src/cli/workspace-path.js";

describe("resolveDefaultWorkspaceDir", () => {
  it("prefers IDEA_FINDER_WORKSPACE over platform defaults", () => {
    expect(resolveDefaultWorkspaceDir({ IDEA_FINDER_WORKSPACE: "/tmp/custom-ws" }, "darwin", () => "/Users/test")).toBe(
      path.resolve("/tmp/custom-ws"),
    );
  });

  it("uses Application Support on macOS", () => {
    expect(resolveDefaultWorkspaceDir({}, "darwin", () => "/Users/test")).toBe(
      "/Users/test/Library/Application Support/idea-finder/workspace",
    );
  });

  it("uses XDG_DATA_HOME on linux when set", () => {
    expect(resolveDefaultWorkspaceDir({ XDG_DATA_HOME: "/var/data" }, "linux", () => "/home/test")).toBe(
      "/var/data/idea-finder/workspace",
    );
  });

  it("falls back to ~/.local/share on linux", () => {
    expect(resolveDefaultWorkspaceDir({}, "linux", () => "/home/test")).toBe(
      "/home/test/.local/share/idea-finder/workspace",
    );
  });
});

describe("resolveCliWorkspaceDir", () => {
  it("prefers --workspace flag, then opts, then env, then default", () => {
    expect(resolveCliWorkspaceDir({
      flag: "/flag",
      optsWorkspaceDir: "/opts",
      env: { IDEA_FINDER_WORKSPACE: "/env" },
      platform: "linux",
      homedir: () => "/home/x",
    })).toBe(path.resolve("/flag"));

    expect(resolveCliWorkspaceDir({
      optsWorkspaceDir: "/opts",
      env: { IDEA_FINDER_WORKSPACE: "/env" },
      platform: "linux",
      homedir: () => "/home/x",
    })).toBe(path.resolve("/opts"));

    expect(resolveCliWorkspaceDir({
      env: { IDEA_FINDER_WORKSPACE: "/env" },
      platform: "linux",
      homedir: () => "/home/x",
    })).toBe(path.resolve("/env"));

    expect(resolveCliWorkspaceDir({ platform: "linux", homedir: () => "/home/x" })).toBe(
      "/home/x/.local/share/idea-finder/workspace",
    );
  });
});

describe("workspace diagnostics non-mutating default", () => {
  const leftovers: string[] = [];
  let previousWorkspaceEnv: string | undefined;

  afterEach(async () => {
    if (previousWorkspaceEnv === undefined) delete process.env.IDEA_FINDER_WORKSPACE;
    else process.env.IDEA_FINDER_WORKSPACE = previousWorkspaceEnv;
    previousWorkspaceEnv = undefined;
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("does not create a missing workspace without --init", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "idea-finder-diag-"));
    leftovers.push(parent);
    const missing = path.join(parent, "does-not-exist-yet");
    const lines: string[] = [];
    const code = await runCli(["workspace", "diagnostics", "--workspace", missing, "--json"], {
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(existsSync(missing)).toBe(false);
    const envelope = JSON.parse(lines.join("\n")) as {
      data: { exists: boolean; initialized: boolean; accessible: boolean; workspace: string };
    };
    expect(envelope.data).toMatchObject({
      workspace: path.resolve(missing),
      exists: false,
      initialized: false,
      accessible: false,
    });
  });

  it("creates the workspace when --init is passed", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "idea-finder-init-"));
    leftovers.push(parent);
    const target = path.join(parent, "new-workspace");
    const lines: string[] = [];
    const code = await runCli(["workspace", "diagnostics", "--workspace", target, "--init", "--json"], {
      stdout: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(existsSync(target)).toBe(true);
    const envelope = JSON.parse(lines.join("\n")) as {
      data: { exists: boolean; initialized: boolean; accessible: boolean };
    };
    expect(envelope.data).toMatchObject({ exists: true, initialized: true, accessible: true });
  });

  it("uses IDEA_FINDER_WORKSPACE as default and does not create cwd-relative data/", async () => {
    previousWorkspaceEnv = process.env.IDEA_FINDER_WORKSPACE;
    const home = await mkdtemp(path.join(os.tmpdir(), "idea-finder-home-"));
    leftovers.push(home);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "idea-finder-cwd-"));
    leftovers.push(cwd);
    const isolatedDefault = path.join(home, "idea-finder-default");
    process.env.IDEA_FINDER_WORKSPACE = isolatedDefault;

    const previousCwd = process.cwd();
    const out: string[] = [];
    try {
      process.chdir(cwd);
      const code = await runCli(["workspace", "diagnostics", "--json"], { stdout: (line) => out.push(line) });
      expect(code).toBe(0);
    } finally {
      process.chdir(previousCwd);
    }

    expect(existsSync(path.join(cwd, "data"))).toBe(false);
    expect(existsSync(isolatedDefault)).toBe(false);
    const envelope = JSON.parse(out.join("\n")) as { data: { workspace: string; exists: boolean } };
    expect(envelope.data.workspace).toBe(path.resolve(isolatedDefault));
    expect(envelope.data.exists).toBe(false);
  });
});
