import path from "node:path";

export function normalizePath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, "/"));
}

export function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedCandidate.startsWith(prefix);
}

export function isPathAllowed(
  target: string,
  allowedRoots: readonly string[],
): boolean {
  return allowedRoots.some((root) => isPathWithin(root, target));
}

export function isUrlAllowed(
  url: string,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  for (const entry of allowlist) {
    if (entry.includes("://")) {
      if (entry.endsWith("*")) {
        const base = entry.slice(0, -1);
        if (urlMatchesOriginAndPathPrefix(parsed, base)) {
          return true;
        }
        continue;
      }
      if (urlMatchesExactEntry(parsed, entry)) {
        return true;
      }
      continue;
    }
    if (parsed.hostname === entry || parsed.hostname.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

/** Wildcard URL patterns: exact origin match, then optional path prefix. */
function urlMatchesOriginAndPathPrefix(url: URL, patternBase: string): boolean {
  let base: URL;
  try {
    base = new URL(patternBase);
  } catch {
    return false;
  }

  if (url.origin !== base.origin) {
    return false;
  }

  if (base.pathname === "/" && !base.search && !base.hash) {
    return true;
  }

  if (!url.pathname.startsWith(base.pathname)) {
    return false;
  }

  if (base.search && url.search !== base.search) {
    return false;
  }

  return true;
}

function urlMatchesExactEntry(url: URL, entry: string): boolean {
  let allowed: URL;
  try {
    allowed = new URL(entry);
  } catch {
    return false;
  }

  if (url.origin !== allowed.origin) {
    return false;
  }
  if (url.pathname !== allowed.pathname) {
    return false;
  }
  if (allowed.search && url.search !== allowed.search) {
    return false;
  }
  return true;
}
