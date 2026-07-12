import os from "node:os";
import path from "node:path";

/** Stable per-user default when neither --workspace nor IDEA_FINDER_WORKSPACE is set. */
export function resolveDefaultWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = () => os.homedir(),
): string {
  const fromEnv = env.IDEA_FINDER_WORKSPACE?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "idea-finder", "workspace");
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share");
  return path.join(xdgDataHome, "idea-finder", "workspace");
}

/** Resolution order: --workspace → opts.workspaceDir → IDEA_FINDER_WORKSPACE → platform user data dir. */
export function resolveCliWorkspaceDir(input: {
  readonly flag?: string;
  readonly optsWorkspaceDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: () => string;
}): string {
  if (input.flag?.trim()) return path.resolve(input.flag.trim());
  if (input.optsWorkspaceDir?.trim()) return path.resolve(input.optsWorkspaceDir.trim());
  return resolveDefaultWorkspaceDir(input.env, input.platform, input.homedir);
}
