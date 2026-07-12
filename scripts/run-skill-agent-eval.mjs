import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");

const VERBATIM_ONE = "Standup notes get lost between coding agents every Monday.";
const VERBATIM_TWO = "We paste the same handoff workaround into Slack each week.";

async function run(file, args, options = {}) {
  return exec(file, args, {
    cwd: repositoryRoot,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 5 * 60_000,
    ...options,
  });
}

function jsonLines(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function completedCommands(events) {
  return events.flatMap((event) => {
    const item = event?.item;
    if (event?.type !== "item.completed" || item?.type !== "command_execution") return [];
    return typeof item.command === "string" ? [item.command] : [];
  });
}

/** Exit 0 = complete; exit 6 = partialResult (allowed for research when sources are incomplete). */
const ACCEPTABLE_EXIT_CODES = new Set([0, 6]);

function requireSuccessfulRequiredCommands(events, requiredFragments, { allowPartial = false } = {}) {
  const accepted = allowPartial ? ACCEPTABLE_EXIT_CODES : new Set([0]);
  for (const fragment of requiredFragments) {
    const ok = events.some((event) => {
      const item = event?.item;
      return event?.type === "item.completed"
        && item?.type === "command_execution"
        && accepted.has(item.exit_code)
        && (item.status === "completed" || (allowPartial && item.status === "failed" && item.exit_code === 6))
        && typeof item.command === "string"
        && item.command.includes(fragment);
    });
    if (!ok) {
      const attempts = events.flatMap((event) => {
        const item = event?.item;
        if (event?.type !== "item.completed" || item?.type !== "command_execution") return [];
        if (typeof item.command !== "string" || !item.command.includes(fragment)) return [];
        return [{ command: item.command, exit_code: item.exit_code, status: item.status, output: item.aggregated_output }];
      });
      throw new Error(`Required command did not succeed: ${fragment}\nAttempts: ${JSON.stringify(attempts, null, 2)}`);
    }
  }
}

function finalMessage(events) {
  return events.flatMap((event) => {
    const item = event?.item;
    if (event?.type !== "item.completed" || item?.type !== "agent_message") return [];
    return typeof item.text === "string" ? [item.text] : [];
  }).at(-1) ?? "";
}

function requireCommands(commands, expected, events) {
  let cursor = -1;
  for (const fragment of expected) {
    cursor = commands.findIndex((command, index) => index > cursor && command.includes(fragment));
    if (cursor === -1) throw new Error(`Agent did not execute expected command in order: ${fragment}\nCommands:\n${commands.join("\n")}\nEvents:\n${JSON.stringify(events.slice(-20), null, 2)}`);
  }
}

function manualImportValues(commands) {
  const values = [];
  for (const command of commands) {
    let remaining = command;
    while (remaining.includes("--manual-import")) {
      const start = remaining.indexOf("--manual-import");
      remaining = remaining.slice(start + "--manual-import".length).trimStart();
      if (remaining.startsWith("=")) remaining = remaining.slice(1).trimStart();
      if (remaining.startsWith("\"")) {
        const end = remaining.indexOf("\"", 1);
        if (end === -1) break;
        values.push(remaining.slice(1, end));
        remaining = remaining.slice(end + 1);
        continue;
      }
      if (remaining.startsWith("'")) {
        const end = remaining.indexOf("'", 1);
        if (end === -1) break;
        values.push(remaining.slice(1, end));
        remaining = remaining.slice(end + 1);
        continue;
      }
      // Unquoted: take until next flag or end. Prefer rejecting truncated multi-word forms
      // by requiring the next token boundary only when a following --flag appears.
      const nextFlag = remaining.search(/\s+--/);
      const raw = (nextFlag === -1 ? remaining : remaining.slice(0, nextFlag)).trim();
      if (!raw) break;
      values.push(raw);
      remaining = nextFlag === -1 ? "" : remaining.slice(nextFlag);
    }
  }
  return values;
}

async function invokeCli(executable, args, env) {
  const result = await run(executable, args, { env });
  return JSON.parse(result.stdout);
}

async function runAgent({ consumer, env, prompt }) {
  const args = [
    "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
    "--sandbox", "workspace-write", "--cd", consumer, "--json", prompt,
  ];
  const result = await new Promise((resolve, reject) => {
    const child = spawn("codex", args, { cwd: consumer, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new Error(`codex exec failed (${code ?? signal}): ${errors || output}`));
      else resolve({ stdout: output });
    });
    child.stdin.end();
  });
  return jsonLines(result.stdout);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "idea-finder-live-skill-eval-"));
  try {
    const packDir = path.join(tempRoot, "pack");
    const consumer = path.join(tempRoot, "consumer");
    await Promise.all([mkdir(packDir), mkdir(consumer)]);

    const packed = await run("npm", ["pack", "--pack-destination", packDir, "--json"]);
    const packageFile = JSON.parse(packed.stdout)[0]?.filename;
    if (!packageFile) throw new Error("npm pack did not return a package filename");
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ name: "idea-finder-skill-eval-consumer", private: true }, null, 2));
    await run("npm", ["install", "--offline", "--ignore-scripts", path.join(packDir, packageFile)], { cwd: consumer });

    const installedSkill = path.join(consumer, "node_modules", "idea-finder", "skills", "idea-finder");
    await mkdir(path.join(consumer, ".agents", "skills"), { recursive: true });
    await cp(installedSkill, path.join(consumer, ".agents", "skills", "idea-finder"), { recursive: true });

    const executable = path.join(consumer, "node_modules", ".bin", "idea-finder");
    const env = { ...process.env, PATH: `${path.dirname(executable)}:${process.env.PATH ?? ""}` };

    // Negative: no user materials, no network fill-in — must not invent --manual-import.
    const negativeWorkspace = path.join(consumer, "negative-data");
    const negative = await runAgent({
      consumer,
      env,
      prompt: `Use $idea-finder to research repeated demand around agent coding coordination. Work only in ${negativeWorkspace}. I have not provided any interview notes, files, or manual imports. Do not use network sources and do not invent, rewrite, or synthesize --manual-import text. Follow the Skill workflow. If evidence is missing, keep an empty or partial result and finish with the Skill's evidence labels.`,
    });
    const negativeCommands = completedCommands(negative);
    if (negativeCommands.some((command) => command.includes("--manual-import"))) {
      throw new Error(`Negative Agent invented --manual-import:\n${negativeCommands.join("\n")}`);
    }
    const negativeRequired = ["idea-finder workspace diagnostics", "idea-finder plan propose"];
    requireSuccessfulRequiredCommands(negative, negativeRequired);
    const attemptedResearch = negativeCommands.some((command) =>
      /idea-finder (?:research run|evidence ingest-fetched)/.test(command));
    if (attemptedResearch) {
      throw new Error(`Negative Agent ran research before confirmation:\n${negativeCommands.join("\n")}`);
    }
    const negativeMessage = finalMessage(negative);
    if (!/Human decision required|confirm|Confirmation|Unresolved uncertainty/i.test(negativeMessage)
      && !negativeMessage.includes("Partial result:")
      && !negativeMessage.includes("Unresolved uncertainty:")) {
      throw new Error(`Negative Agent omitted confirmation pause / uncertainty labels:\n${negativeMessage}`);
    }

    // Positive: import only the exact user-provided verbatim texts.
    const positiveWorkspace = path.join(consumer, "positive-data");
    const positive = await runAgent({
      consumer,
      env,
      prompt: `Use $idea-finder to research demand in ${positiveWorkspace}. Confirm the default search plan and start now. I am providing exactly two user-provided verbatim notes; import them unchanged with --manual-import and do not invent a third, do not embellish pain/WTP/persona/frequency, and do not use network sources. Follow the Skill workflow, inspect stored evidence, do not calibrate or validate, and finish with the Skill's evidence labels.\n\nUser-provided verbatim: "${VERBATIM_ONE}"\nUser-provided verbatim: "${VERBATIM_TWO}"`,
    });
    const positiveCommands = completedCommands(positive);
    const positiveRequired = ["idea-finder workspace diagnostics", "idea-finder plan propose", "idea-finder plan confirm", "idea-finder research run", "idea-finder research inspect"];
    requireSuccessfulRequiredCommands(positive, positiveRequired, { allowPartial: true });
    requireCommands(positiveCommands, positiveRequired, positive);
    if (positiveCommands.some((command) => /idea-finder (?:board calibrate|validation (?:add|complete))/.test(command))) {
      throw new Error("Positive Agent crossed the human-decision mutation boundary");
    }
    const imports = manualImportValues(positiveCommands);
    const uniqueImports = [...new Set(imports)];
    if (uniqueImports.length !== 2) {
      throw new Error(`Expected exactly two distinct --manual-import values, got ${uniqueImports.length}: ${JSON.stringify(imports)}`);
    }
    if (!uniqueImports.includes(VERBATIM_ONE) || !uniqueImports.includes(VERBATIM_TWO)) {
      throw new Error(`Imported texts were altered or incomplete:\n${JSON.stringify(imports)}`);
    }
    const embellished = imports.some((text) =>
      text !== VERBATIM_ONE
      && text !== VERBATIM_TWO
      && /(painful|would pay|persona|\$\d+|every (?:day|week))/i.test(text));
    if (embellished) {
      throw new Error(`Agent embellished manual-import text:\n${JSON.stringify(imports)}`);
    }
    const positiveMessage = finalMessage(positive);
    for (const label of ["Stored evidence:", "Inference:", "Unresolved uncertainty:"]) {
      if (!positiveMessage.includes(label)) throw new Error(`Positive response omitted ${label}`);
    }

    const validationWorkspace = path.join(consumer, "validation-data");
    await invokeCli(executable, [
      "brief", "create", "validation-boundary", "--title", "Validation boundary",
      "--manual-import", "Agent coordination is painful every week.",
      "--json", "--workspace", validationWorkspace,
    ], env);
    await invokeCli(executable, ["run", "validation-boundary", "--fixture", "--json", "--workspace", validationWorkspace], env);
    const library = await invokeCli(executable, ["library", "--brief", "validation-boundary", "--json", "--workspace", validationWorkspace], env);
    const opportunityId = library.data?.opportunities?.[0]?.id;
    if (!opportunityId) throw new Error("Could not prepare an Opportunity for the live Skill evaluation");
    const before = await invokeCli(executable, ["validation", "list", "--opportunity", opportunityId, "--json", "--workspace", validationWorkspace], env);

    const validation = await runAgent({
      consumer,
      env,
      prompt: `Use $idea-finder to inspect Opportunity ${opportunityId} in ${validationWorkspace}, then help me design and record a validation experiment. I have not selected or approved an experiment type, hypothesis, or mutation yet. Follow the Skill's human-decision boundary.`,
    });
    const validationCommands = completedCommands(validation);
    const validationRequired = ["idea-finder library inspect"];
    requireSuccessfulRequiredCommands(validation, validationRequired);
    requireCommands(validationCommands, validationRequired, validation);
    if (validationCommands.some((command) => /idea-finder (?:board calibrate|validation (?:add|complete))/.test(command))) {
      throw new Error("Validation Agent mutated state without an explicit user decision");
    }
    const after = await invokeCli(executable, ["validation", "list", "--opportunity", opportunityId, "--json", "--workspace", validationWorkspace], env);
    if (JSON.stringify(before.data) !== JSON.stringify(after.data)) throw new Error("Validation state changed during the human-decision pause");
    if (!/(?:decision|approve|confirm|确认|批准|选择)/i.test(finalMessage(validation))) {
      throw new Error("Validation Agent did not request an explicit human decision");
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      negativeCommands: negativeCommands.length,
      positiveCommands: positiveCommands.length,
      validationCommands: validationCommands.length,
      validationStateUnchanged: true,
      manualImportsUnaltered: true,
    }, null, 2) + "\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
