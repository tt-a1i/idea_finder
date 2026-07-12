import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { asId } from "@idea-finder/core";
import { createGitHubIssuesConnector } from "../src/connectors/github-issues.js";
import { createHnAlgoliaConnector } from "../src/connectors/hn-algolia.js";
import { createStackExchangeConnector } from "../src/connectors/stack-exchange.js";

const fixtures = path.resolve(import.meta.dirname, "fixtures");
const taskId = asId("task_qual");

function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
}

describe("qualitative source deepenings", () => {
  it("GitHub Issues connector excludes PRs and keeps issue title/body provenance", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/search/issues")) {
        return new Response(JSON.stringify({
          items: [
            {
              id: 1,
              number: 10,
              title: "Build fails on Monday",
              body: "This workaround is painful",
              html_url: "https://github.com/owner/repo/issues/10",
              user: { login: "dev" },
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              state: "open",
              labels: [{ name: "bug" }],
              reactions: { total_count: 3 },
              comments: 0,
              repository_url: "https://api.github.com/repos/owner/repo",
            },
            {
              id: 2,
              number: 11,
              title: "PR should be skipped",
              body: "ignore",
              html_url: "https://github.com/owner/repo/pull/11",
              user: { login: "dev" },
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              state: "open",
              pull_request: {},
              comments: 0,
            },
          ],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const connector = createGitHubIssuesConnector({ fetchFn, token: "test-token", minIntervalMs: 0, commentBudget: 0 });
    const docs = [];
    for await (const doc of connector.search({ platform: "github_issues", terms: ["painful"], huntingTaskId: taskId, limit: 5, since: "2026-01-01T00:00:00.000Z" })) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(1);
    expect(docs[0]?.url).toContain("/issues/10");
    expect(docs[0]?.rawBody).toContain("Build fails on Monday");
    expect(docs[0]?.rawBody).toContain("This workaround is painful");
    expect(JSON.stringify(seen)).not.toContain("test-token");
    expect(seen[0]).toMatch(/is(%3A|:)issue/);
  });

  it("HN comment search stores parent/story linkage", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      hits: [{
        objectID: "99",
        comment_text: "The workaround is painful",
        author: "bob",
        created_at: "2026-01-01T00:00:00.000Z",
        parent_id: 1,
        story_id: 42,
        story_title: "Agent coding",
      }],
    }), { status: 200 })) as typeof fetch;
    const connector = createHnAlgoliaConnector({ fetchFn, baseUrl: "https://hn.test/api/v1", minIntervalMs: 0 });
    const docs = [];
    for await (const doc of connector.search({
      platform: "hn",
      terms: ["workaround"],
      huntingTaskId: taskId,
      hnTags: "comment",
    })) {
      docs.push(doc);
    }
    expect(docs[0]?.contentType).toBe("comment");
    expect(docs[0]?.rawBody).toContain("Story-ID: 42");
    expect(docs[0]?.rawBody).toContain("Parent-ID: 1");
  });

  it("Stack Exchange saves accepted/top answer metadata", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/advanced")) {
        return new Response(JSON.stringify(load("stack-exchange-search.json")), { status: 200 });
      }
      if (url.includes("/answers")) {
        return new Response(JSON.stringify({
          items: [{
            answer_id: 9,
            body: "<p>Use this mature workaround</p>",
            score: 12,
            is_accepted: true,
            creation_date: 1_700_000_000,
            link: "https://stackoverflow.com/a/9",
          }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const connector = createStackExchangeConnector({ fetchFn, baseUrl: "https://api.stackexchange.test/2.3", minIntervalMs: 0 });
    const docs = [];
    for await (const doc of connector.search({ platform: "stack_exchange", terms: ["tool"], huntingTaskId: taskId, limit: 5 })) {
      docs.push(doc);
    }
    expect(docs.some((doc) => doc.rawBody.includes("Accepted-Answer-Id"))).toBe(true);
    expect(docs.some((doc) => doc.rawBody.includes("Accepted: true"))).toBe(true);
    expect(docs.some((doc) => doc.rawBody.includes("Parent-Question"))).toBe(true);
  });
});
