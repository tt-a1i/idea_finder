import { execFileSync } from "node:child_process";

export type GithubTokenResolver = () => string | undefined;

/**
 * Resolve a GitHub API token without logging or persisting it.
 * Order: explicit option → GITHUB_TOKEN → GH_TOKEN → `gh auth token` when available.
 */
export function resolveGithubToken(explicit?: string | null, resolver?: GithubTokenResolver): string | undefined {
  if (explicit !== undefined && explicit !== null) {
    const trimmed = explicit.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (resolver) return normalizeToken(resolver());
  return normalizeToken(process.env.GITHUB_TOKEN)
    ?? normalizeToken(process.env.GH_TOKEN)
    ?? readGhAuthToken();
}

function normalizeToken(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readGhAuthToken(): string | undefined {
  try {
    const stdout = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return normalizeToken(stdout.split(/\r?\n/, 1)[0] ?? "");
  } catch {
    return undefined;
  }
}
