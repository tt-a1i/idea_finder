import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const skillRoot = path.join(root, "skills", "idea-finder");

describe("idea-finder companion Skill evaluations", () => {
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
    expect(manifest.cases.map((item) => item.id).sort()).toEqual(["discovery", "evidence-inspection", "focused-research", "incomplete-research", "monitoring", "validation"]);
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
