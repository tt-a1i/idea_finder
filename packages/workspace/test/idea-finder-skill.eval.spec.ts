import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractUserProvidedVerbatims,
  runSkillWorkflow,
} from "./support/skill-workflow-harness.js";

const root = path.resolve(import.meta.dirname, "../../..");
const skillRoot = path.join(root, "skills", "idea-finder");

function allArgs(trace: Awaited<ReturnType<typeof runSkillWorkflow>>): string[] {
  return trace.commands.flatMap((command) => [...command.args]);
}

function manualImportValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--manual-import" && typeof args[index + 1] === "string") {
      values.push(args[index + 1]!);
      index += 1;
    }
  }
  return values;
}

describe("idea-finder companion Skill evaluations", () => {
  it("loads the Skill and executes a discovery workflow without inventing manual imports", async () => {
    const trace = await runSkillWorkflow({
      skillPath: path.join(skillRoot, "SKILL.md"),
      prompt: "帮我发现 agent coding 工作流里真实、反复出现的需求。",
    });

    expect(trace.commands.map((command) => command.command)).toEqual([
      "workspace diagnostics",
      "brief create",
      "research run",
      "research inspect",
    ]);
    expect(trace.commands.every((command) => command.exitCode === 0 || command.exitCode === 6)).toBe(true);
    expect(trace.commands.every((command) => command.envelope.contractVersion === "1.0")).toBe(true);
    expect(JSON.stringify(trace.commands)).not.toMatch(/--fixture(?:-set)?/);
    expect(allArgs(trace)).not.toContain("--manual-import");
    expect(manualImportValues(allArgs(trace))).toEqual([]);
    expect(trace.commands.some((command) => command.args.includes("--source") && command.args.includes("hn"))).toBe(true);
    expect(trace.response).toContain("Stored evidence:");
    expect(trace.response).toContain("Inference:");
    expect(trace.pausedForHumanDecision).toBe(false);
  }, 30_000);

  it("reports partial or unresolved uncertainty instead of forging evidence when sources yield nothing", async () => {
    const trace = await runSkillWorkflow({
      skillPath: path.join(skillRoot, "SKILL.md"),
      prompt: "帮我发现真实需求。我没有提供任何访谈笔记或人工材料，公开来源也不可用。",
    });

    expect(allArgs(trace)).not.toContain("--manual-import");
    expect(allArgs(trace)).not.toContain("--source");
    const hasPartialOrUnresolved =
      trace.response.includes("Partial result:") || trace.response.includes("Unresolved uncertainty:");
    expect(hasPartialOrUnresolved).toBe(true);
    expect(trace.response).not.toMatch(/Agent coding coordination is painful/);
  }, 15_000);

  it("imports only the exact user-provided verbatim text without embellishment", async () => {
    const verbatim = "Coordination handoffs break every Monday standup.";
    const embellished = `${verbatim} This is painful, I would pay $20/mo, persona: senior engineer, repeats weekly.`;
    const prompt = `导入这段用户原文并研究：User-provided verbatim (deterministic test fixture): "${verbatim}"`;
    expect(extractUserProvidedVerbatims(prompt)).toEqual([verbatim]);

    const trace = await runSkillWorkflow({
      skillPath: path.join(skillRoot, "SKILL.md"),
      prompt,
    });

    const imports = manualImportValues(allArgs(trace));
    expect(imports).toEqual([verbatim]);
    expect(imports).not.toContain(embellished);
    expect(imports.every((text) => text === verbatim)).toBe(true);
  });

  it("does not invent a third manual import when the user provides only two texts", async () => {
    const first = "Standup notes get lost between agents every week.";
    const second = "We paste the same workaround into Slack on Mondays.";
    const prompt = [
      "研究这些用户原文：",
      `User-provided verbatim (deterministic test fixture): "${first}"`,
      `User-provided verbatim (deterministic test fixture): "${second}"`,
    ].join("\n");

    const trace = await runSkillWorkflow({
      skillPath: path.join(skillRoot, "SKILL.md"),
      prompt,
    });

    expect(manualImportValues(allArgs(trace))).toEqual([first, second]);
    expect(trace.response).toContain("one manual lane, not cross-source corroboration");
  });

  it("pins manual-import authenticity rules in the Skill contract", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).toContain("Manual import authenticity");
    expect(skill).toContain("Never invent, complete, rewrite, translate, paraphrase, synthesize, or infer manual-import text");
    expect(skill).toContain("Never treat agent reasoning, examples, fixtures, or test prompts as real evidence");
    expect(skill).toContain("do not call `--manual-import` to fill the gap");
    expect(skill).toContain("same user turn do not count as multiple independent sources");
    const workflows = await readFile(path.join(skillRoot, "references", "cli-workflows.md"), "utf8");
    expect(workflows).toMatch(/user-provided verbatim/i);
    expect(workflows).toMatch(/deterministic test fixture/i);
  });

  it("refuses fixture flags when the user asks for real live research", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).toMatch(/Never pass `--fixture` or `--fixture-set` when the user asks for real\/live research/);
    expect(skill).toContain("Never invent or paste fixture data");
    const workflows = await readFile(path.join(skillRoot, "references", "cli-workflows.md"), "utf8");
    expect(workflows).toContain("never add --fixture / --fixture-set for real studies");
  });

  it("loads the human-decision boundary and pauses validation before mutation", async () => {
    const trace = await runSkillWorkflow({
      skillPath: path.join(skillRoot, "SKILL.md"),
      prompt: "检查这个 Opportunity，然后帮我设计并记录验证实验。",
      fixtureContext: "opportunity",
    });

    expect(trace.commands.map((command) => command.command)).toEqual(["library inspect"]);
    expect(trace.commands[0]?.exitCode).toBe(0);
    expect(trace.response).toContain("Human decision required:");
    expect(trace.pausedForHumanDecision).toBe(true);
  });

  it("has valid concise metadata, UI metadata, and resolvable references", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    expect(skill.split("\n").length).toBeLessThan(500);
    expect(skill).toMatch(/^---\nname: idea-finder\ndescription: .+\n---/);
    expect(skill).not.toContain("TODO");
    expect(await readFile(path.join(skillRoot, "references", "cli-workflows.md"), "utf8")).toContain("# Canonical CLI workflows");
    const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
    expect(metadata).toContain('display_name: "Idea Finder"');
    expect(metadata).toContain("$idea-finder");
  });

  it("covers all representative prompts with commands, labels, and forbidden behavior", async () => {
    const manifest = JSON.parse(await readFile(path.join(skillRoot, "evals", "cases.json"), "utf8")) as { skill: string; cases: Array<{ id: string; prompt: string; expectedCommands: string[]; requiredResponseLabels: string[]; forbiddenCommands: string[] }> };
    expect(manifest.skill).toBe("idea-finder");
    expect(manifest.cases.map((item) => item.id).sort()).toEqual([
      "discovery",
      "discovery-no-user-materials",
      "evidence-inspection",
      "focused-research",
      "incomplete-research",
      "manual-import-verbatim",
      "monitoring",
      "validation",
    ]);
    for (const evaluation of manifest.cases) {
      expect(evaluation.prompt.length).toBeGreaterThan(10);
      expect(evaluation.expectedCommands.length).toBeGreaterThan(0);
      expect(evaluation.requiredResponseLabels.length).toBeGreaterThan(0);
      expect(evaluation.forbiddenCommands.length).toBeGreaterThan(0);
    }
    const traces = JSON.parse(await readFile(path.join(skillRoot, "evals", "traces.json"), "utf8")) as { traces: Array<{ caseId: string; commands: string[]; response: string; pausedForHumanDecision: boolean }> };
    expect(traces.traces.map((item) => item.caseId).sort()).toEqual(manifest.cases.map((item) => item.id).sort());
    for (const evaluation of manifest.cases) {
      const trace = traces.traces.find((item) => item.caseId === evaluation.id)!;
      expect(trace.commands.every((command) => command.startsWith("idea-finder ") && command.endsWith("--json"))).toBe(true);
      let previousIndex = -1;
      for (const expected of evaluation.expectedCommands) {
        const tokens = expected.split(/\s+/);
        const index = trace.commands.findIndex((command, commandIndex) => commandIndex > previousIndex && tokens.every((token) => command.includes(token)));
        expect(index, `${evaluation.id} missing ordered command ${expected}`).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
      for (const forbidden of evaluation.forbiddenCommands.filter((item) => !item.includes(" ") || ["board calibrate", "validation add", "validation complete", "brief create"].includes(item))) {
        expect(trace.commands.join("\n")).not.toContain(forbidden);
      }
      for (const label of evaluation.requiredResponseLabels) expect(trace.response).toContain(`${label}:`);
      if (evaluation.id === "validation") expect(trace.pausedForHumanDecision).toBe(true);
      if (evaluation.id === "manual-import-verbatim") {
        expect(trace.commands.some((command) => command.includes("--manual-import Coordination handoffs break every Monday standup."))).toBe(true);
      }
    }
  });

  it("orchestrates only canonical CLI workflows and pins the safety vocabulary", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const reference = await readFile(path.join(skillRoot, "references", "cli-workflows.md"), "utf8");
    const combined = `${skill}\n${reference}`;
    for (const forbidden of ["WorkspaceService", "openLocalStorage", "scoreVector", "admitToLibrary", "applyCalibration", "SELECT ", "INSERT INTO"]) expect(combined).not.toContain(forbidden);
    for (const required of ["Stored evidence", "Inference", "Trend-only lead", "Contradictory evidence", "Partial result", "Unresolved uncertainty", "explicit user decision", "login-gated", "user-provided import"]) expect(skill).toContain(required);
    const workflowCommands = [...reference.matchAll(/^idea-finder .+$/gm)].map((match) => match[0]);
    expect(workflowCommands.length).toBeGreaterThanOrEqual(10);
    expect(workflowCommands.every((command) => command.endsWith("--json"))).toBe(true);
    expect(skill).toContain("Never recreate persistence, scoring, admission, calibration, or monitoring logic");
  });
});
