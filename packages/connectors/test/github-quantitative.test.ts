import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createGitHubQuantitativeConnector } from "../src/connectors/github.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

function fixtureFetch(repository = "github-repository.json") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = url.includes("/issues?")
      ? load("github-issues.json")
      : url.includes("/contributors?")
        ? load("github-contributors.json")
        : load(repository);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function paginatedFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/issues?") && !url.includes("page=2")) {
      return new Response(JSON.stringify([{ id: 101, created_at: "2026-07-09T10:00:00Z", closed_at: null }]), {
        status: 200,
        headers: { "Content-Type": "application/json", Link: '<https://api.github.test/repos/octocat/Hello-World/issues?state=all&per_page=100&page=2>; rel="next"' },
      });
    }
    if (url.includes("/issues?") && url.includes("page=2")) {
      return new Response(JSON.stringify([
        { id: 101, created_at: "2026-07-09T10:00:00Z", closed_at: null },
        { id: 102, created_at: "2026-07-10T10:00:00Z", closed_at: null },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/contributors?")) {
      return new Response(JSON.stringify(load("github-contributors.json")), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(load("github-repository.json")), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("GitHub quantitative connector", () => {
  it("collects normalized repository, issue, and contributor metrics without qualitative documents", async () => {
    const fetchFn = fixtureFetch();
    const connector = createGitHubQuantitativeConnector({
      fetchFn,
      baseUrl: "https://api.github.test",
      token: "test-token",
      minIntervalMs: 0,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    const observations = await connector.collect({ subject: "octocat/Hello-World", since: "2026-07-09T00:00:00Z" });

    expect(observations).toHaveLength(6);
    expect(Object.fromEntries(observations.map((item) => [item.metric, item.normalizedValue]))).toEqual({
      "github.repository.stars": 2150,
      "github.repository.forks": 1410,
      "github.repository.open_issues": 1,
      "github.issue.opened": 1,
      "github.issue.closed": 1,
      "github.repository.contributors": 2,
    });
    expect(observations[0]).toMatchObject({
      subject: "github:octocat/hello-world",
      source: "github",
      geography: null,
      observedAt: "2026-07-11T00:00:00.000Z",
      rawValue: 2150,
      unit: "count",
      collectionMethod: "authorized_public_api",
      provenance: { apiVersion: "2022-11-28", endpoint: "/repos/{owner}/{repo}" },
    });
    expect(observations[0]).not.toHaveProperty("rawBody");
    expect(observations[0]).not.toHaveProperty("evidenceClass");
    expect(new Set(observations.map((item) => item.id)).size).toBe(6);

    const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, init] of calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(headers.get("user-agent")).toContain("idea-finder");
    }
    expect(calls.some(([input]) => String(input).includes("anon=true"))).toBe(false);
  });

  it("uses stable observation ids for deterministic collection time and supports anonymous public access", async () => {
    const fetchFn = fixtureFetch();
    const connector = createGitHubQuantitativeConnector({
      fetchFn, baseUrl: "https://api.github.test", token: "", minIntervalMs: 0,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    const first = await connector.collect({ subject: "github:octocat/Hello-World" });
    const second = await connector.collect({ subject: "octocat/Hello-World" });
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    const headers = new Headers((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("follows authorized API pagination and deduplicates observations across pages", async () => {
    const connector = createGitHubQuantitativeConnector({
      fetchFn: paginatedFetch(), baseUrl: "https://api.github.test", token: "", minIntervalMs: 0,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    const observations = await connector.collect({ subject: "octocat/Hello-World", since: "2026-07-09T00:00:00Z" });
    expect(observations.find((item) => item.metric === "github.issue.opened")?.normalizedValue).toBe(2);
  });

  it("rejects cross-origin pagination before forwarding authorization", async () => {
    expect(() => createGitHubQuantitativeConnector({ baseUrl: "http://api.github.test" })).toThrow("must use HTTPS");
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues?")) {
        return new Response("[]", { status: 200, headers: { Link: '<https://evil.test/steal>; rel="next"' } });
      }
      return new Response(JSON.stringify(load("github-repository.json")), { status: 200 });
    }) as typeof fetch;
    const connector = createGitHubQuantitativeConnector({ fetchFn, baseUrl: "https://api.github.test", token: "secret", minIntervalMs: 0 });
    await expect(connector.collect({ subject: "octocat/Hello-World" })).rejects.toThrow("rejected cross-origin URL");
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => String(input).includes("evil.test"))).toBe(false);
  });

  it("performs requests serially and surfaces GitHub rate-limit guidance", async () => {
    let active = 0;
    let maximum = 0;
    const serialFetch = vi.fn(async (input: RequestInfo | URL) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const url = String(input);
      const body = url.includes("/issues?") ? [] : url.includes("/contributors?") ? [] : load("github-repository.json");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await createGitHubQuantitativeConnector({ fetchFn: serialFetch, baseUrl: "https://api.github.test", token: "", minIntervalMs: 0 })
      .collect({ subject: "octocat/Hello-World" });
    expect(maximum).toBe(1);

    const limited = vi.fn(async () => new Response("rate limited", {
      status: 403,
      headers: { "Retry-After": "60", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1783728060" },
    })) as typeof fetch;
    const limitedConnector = createGitHubQuantitativeConnector({
      fetchFn: limited, baseUrl: "https://api.github.test", token: "", minIntervalMs: 0,
      now: () => new Date("2026-07-10T23:59:00.000Z"),
    });
    await expect(limitedConnector.collect({ subject: "octocat/Hello-World" }))
      .rejects.toMatchObject({ name: "GitHubRateLimitError", retryAfterSeconds: 60, resetAt: "2026-07-11T00:01:00.000Z" });
    expect(limited).toHaveBeenCalledTimes(1);
    await expect(limitedConnector.collect({ subject: "octocat/Hello-World" }))
      .rejects.toMatchObject({ name: "GitHubRateLimitError", resetAt: "2026-07-11T00:01:00.000Z" });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it("maps bare 401/403 without rate-limit signals to authorization errors", async () => {
    for (const status of [401, 403] as const) {
      const fetchFn = vi.fn(async () => new Response("denied", { status })) as typeof fetch;
      const connector = createGitHubQuantitativeConnector({
        fetchFn, baseUrl: "https://api.github.test", token: "bad", minIntervalMs: 0,
      });
      await expect(connector.collect({ subject: "octocat/Hello-World" }))
        .rejects.toMatchObject({
          name: "GitHubAuthorizationError",
          statusCode: status,
          message: expect.stringMatching(/unauthorized/i),
        });
    }
  });

  it("validates since before network access and rejects conflicting duplicate payloads", async () => {
    const neverFetch = vi.fn() as unknown as typeof fetch;
    const invalid = createGitHubQuantitativeConnector({ fetchFn: neverFetch, baseUrl: "https://api.github.test", token: "", minIntervalMs: 0 });
    await expect(invalid.collect({ subject: "octocat/Hello-World", since: "yesterday" })).rejects.toThrow("since must be ISO date-time");
    expect(neverFetch).not.toHaveBeenCalled();

    const conflicting = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/issues?")
        ? [
          { id: 101, created_at: "2026-07-09T10:00:00Z", closed_at: null },
          { id: 101, created_at: "2026-07-10T10:00:00Z", closed_at: null },
        ]
        : url.includes("/contributors?") ? [] : load("github-repository.json");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await expect(createGitHubQuantitativeConnector({ fetchFn: conflicting, baseUrl: "https://api.github.test", token: "", minIntervalMs: 0 })
      .collect({ subject: "octocat/Hello-World" })).rejects.toThrow("conflicting duplicate issue.id 101");
  });

  it("fails closed on recorded source drift", async () => {
    const connector = createGitHubQuantitativeConnector({
      fetchFn: fixtureFetch("github-repository-drift.json"),
      baseUrl: "https://api.github.test",
      token: "",
      minIntervalMs: 0,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    await expect(connector.collect({ subject: "octocat/Hello-World" }))
      .rejects.toThrow("repository.stargazers_count must be a non-negative number");
  });

  it("reuses GH_TOKEN / resolver credentials without leaking the token into errors", async () => {
    const secret = "ghs_test_secret_token_never_log";
    const fetchFn = fixtureFetch();
    const connector = createGitHubQuantitativeConnector({
      fetchFn,
      baseUrl: "https://api.github.test",
      tokenResolver: () => secret,
      minIntervalMs: 0,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    await connector.collect({ subject: "octocat/Hello-World" });
    const headers = new Headers((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${secret}`);

    const denied = vi.fn(async () => new Response("denied", { status: 401 })) as typeof fetch;
    const failing = createGitHubQuantitativeConnector({
      fetchFn: denied, baseUrl: "https://api.github.test", token: secret, minIntervalMs: 0,
    });
    await expect(failing.collect({ subject: "octocat/Hello-World" })).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      return true;
    });
  });
});
