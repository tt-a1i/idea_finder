import { describe, expect, it } from "vitest";

import { isUrlAllowed } from "../src/policy/path-url.js";

describe("isUrlAllowed", () => {
  it("allows paths on a trailing-slash wildcard origin", () => {
    const allowlist = ["https://news.ycombinator.com/*"];
    expect(isUrlAllowed("https://news.ycombinator.com/item?id=1", allowlist)).toBe(true);
    expect(isUrlAllowed("https://news.ycombinator.com/newest", allowlist)).toBe(true);
  });

  it("does not treat sibling domains as prefix matches (evil.com* fix)", () => {
    const allowlist = ["https://evil.com*"];
    expect(isUrlAllowed("https://evil.com/", allowlist)).toBe(true);
    expect(isUrlAllowed("https://evil.com/phish", allowlist)).toBe(true);
    expect(isUrlAllowed("https://evil.com.attacker.com/", allowlist)).toBe(false);
    expect(isUrlAllowed("https://evil.com.attacker.com/phish", allowlist)).toBe(false);
  });

  it("supports path-prefix wildcards on the same origin", () => {
    const allowlist = ["https://news.ycombinator.com/item*"];
    expect(isUrlAllowed("https://news.ycombinator.com/item?id=42", allowlist)).toBe(true);
    expect(isUrlAllowed("https://news.ycombinator.com/items", allowlist)).toBe(true);
    expect(isUrlAllowed("https://news.ycombinator.com/newest", allowlist)).toBe(false);
    expect(isUrlAllowed("https://other.example.com/item", allowlist)).toBe(false);
  });

  it("matches exact URL entries without wildcards", () => {
    const allowlist = ["https://example.com/exact"];
    expect(isUrlAllowed("https://example.com/exact", allowlist)).toBe(true);
    expect(isUrlAllowed("https://example.com/exact/extra", allowlist)).toBe(false);
  });

  it("matches hostname-only allowlist entries", () => {
    const allowlist = ["example.com"];
    expect(isUrlAllowed("https://example.com/foo", allowlist)).toBe(true);
    expect(isUrlAllowed("https://api.example.com/foo", allowlist)).toBe(true);
    expect(isUrlAllowed("https://notexample.com/foo", allowlist)).toBe(false);
  });
});
