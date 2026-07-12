#!/usr/bin/env node
// npm bin shims invoke plain `node`, so Node 22 would otherwise print
// node:sqlite ExperimentalWarning on stderr and break the agent contract.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "idea-finder.js");
const result = spawnSync(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", app, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);
