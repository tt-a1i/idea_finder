import path from "node:path";

import { createApiServer, defaultWorkspaceDir, resolveWebApiConfig } from "./api-server.js";

const port = Number(process.env.WEB_API_PORT ?? 4177);
const workspaceDir = process.env.WEB_WORKSPACE_DIR ?? defaultWorkspaceDir();
const config = resolveWebApiConfig({});

const api = createApiServer({
  workspaceDir,
  port,
  ...config,
});
const { port: boundPort, close } = await api.listen();

console.log(`[web-api] workspace API on http://127.0.0.1:${boundPort}`);
console.log(
  `[web-api] runner=${config.runnerMode} harvest=${config.harvestMode} dir=${path.resolve(workspaceDir)}`,
);

async function shutdown(): Promise<void> {
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
