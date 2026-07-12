import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createNpmDownloadsConnector } from "../src/connectors/npm-downloads.js";
import { createPyPiDownloadsConnector } from "../src/connectors/pypi-downloads.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const window = { from: "2026-07-01", to: "2026-07-03" };

describe("package download connectors", () => {
  it("parses official npm range data, preserves zero, and encodes scoped identity", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture("npm-downloads-range.json")), { status: 200 })) as typeof fetch;
    const result = await createNpmDownloadsConnector({ fetchFn, baseUrl: "https://npm.test", minIntervalMs: 0, now: () => new Date("2026-07-04T00:00:00Z") }).collect({ package: "@scope/tool", ...window });
    expect(result).toMatchObject({ ecosystem: "npm", package: "@scope/tool", buckets: [{ downloads: 0 }, { downloads: 12 }, { downloads: 24 }], provenance: { provider: "npm", interface: "npm_downloads_public_api", caveat: null } });
    expect(String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain("%40scope%2Ftool");
    expect(result.buckets[0]?.subject).toBe("npm:@scope/tool");
  });

  it("parses pypistats as an explicit third-party source with PEP 503 identity", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture("pypistats-overall.json")), { status: 200 })) as typeof fetch;
    const result = await createPyPiDownloadsConnector({ fetchFn, baseUrl: "https://pypistats.test", minIntervalMs: 0, now: () => new Date("2026-07-04T00:00:00Z") }).collect({ package: "Some.Package", ...window });
    expect(result).toMatchObject({ ecosystem: "pypi", package: "some-package", buckets: [{ downloads: 0 }, { downloads: 7 }, { downloads: 15 }], provenance: { provider: "pypistats", interface: "pypistats_public_api" } });
    expect(result.provenance.caveat).toContain("not an official PyPI statistics API");
    expect(String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain("mirrors=false");
    expect(result.buckets[0]?.subject).toBe("pypi:some-package");
  });

  it("validates package and window before network and reports missing/empty/drift", async () => {
    const never = vi.fn() as unknown as typeof fetch;
    const npm = createNpmDownloadsConnector({ fetchFn: never, baseUrl: "https://npm.test" });
    await expect(npm.collect({ package: "bad package", ...window })).rejects.toThrow("Invalid npm package");
    await expect(npm.collect({ package: "UpperCase", ...window })).rejects.toThrow("Invalid npm package");
    await expect(npm.collect({ package: "ok", from: "2026-07-04", to: "2026-07-03" })).rejects.toThrow("must not be after");
    expect(never).not.toHaveBeenCalled();

    const response = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    await expect(createNpmDownloadsConnector({ fetchFn: response(404, {}), baseUrl: "https://npm.test", minIntervalMs: 0 }).collect({ package: "missing", ...window })).rejects.toMatchObject({ status: "missing_package" });
    await expect(createNpmDownloadsConnector({ fetchFn: response(200, { ...fixture("npm-downloads-range.json"), downloads: [] }), baseUrl: "https://npm.test", minIntervalMs: 0 }).collect({ package: "@scope/tool", ...window })).rejects.toMatchObject({ status: "unavailable_history" });
    const partial = await createNpmDownloadsConnector({
      fetchFn: response(200, { ...fixture("npm-downloads-range.json"), downloads: fixture("npm-downloads-range.json").downloads.slice(1) }),
      baseUrl: "https://npm.test",
      minIntervalMs: 0,
      now: () => new Date("2026-07-04T00:00:00Z"),
    }).collect({ package: "@scope/tool", ...window });
    expect(partial.coverageComplete).toBe(false);
    expect(partial.missingDays).toEqual(["2026-07-01"]);
    expect(partial.buckets.map((item) => item.downloads)).toEqual([12, 24]);
    await expect(createNpmDownloadsConnector({ fetchFn: response(200, fixture("npm-downloads-drift.json")), baseUrl: "https://npm.test", minIntervalMs: 0 }).collect({ package: "@scope/tool", ...window })).rejects.toMatchObject({ status: "response_drift" });
    await expect(createPyPiDownloadsConnector({ fetchFn: response(200, fixture("pypistats-drift.json")), baseUrl: "https://pypistats.test", minIntervalMs: 0 }).collect({ package: "some-package", ...window })).rejects.toMatchObject({ status: "response_drift" });
  });

  it("does not treat future npm zeros as comparable history and keeps true zeros for completed days", async () => {
    const body = {
      ...fixture("npm-downloads-range.json"),
      start: "2026-07-01",
      end: "2026-07-04",
      downloads: [
        { day: "2026-07-01", downloads: 10 },
        { day: "2026-07-02", downloads: 0 },
        { day: "2026-07-03", downloads: 20 },
        { day: "2026-07-04", downloads: 0 },
      ],
    };
    const result = await createNpmDownloadsConnector({
      fetchFn: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
      baseUrl: "https://npm.test",
      minIntervalMs: 0,
      now: () => new Date("2026-07-03T12:00:00Z"),
    }).collect({ package: "@scope/tool", from: "2026-07-01", to: "2026-07-04" });
    expect(result.buckets.map((item) => ({ day: item.day, downloads: item.downloads }))).toEqual([
      { day: "2026-07-01", downloads: 10 },
      { day: "2026-07-02", downloads: 0 },
      { day: "2026-07-03", downloads: 20 },
    ]);
    expect(result.missingDays).toEqual(["2026-07-04"]);
    expect(result.coverageComplete).toBe(false);
  });

  it.each(["npm", "pypi"] as const)("locally trips the %s retry window without a second request", async (ecosystem) => {
    const fetchFn = vi.fn(async () => new Response("rate", { status: 429, headers: { "Retry-After": "60" } })) as typeof fetch;
    const options = { fetchFn, baseUrl: ecosystem === "npm" ? "https://npm.test" : "https://pypistats.test", minIntervalMs: 0, now: () => new Date("2026-07-04T00:00:00Z") };
    const connector = ecosystem === "npm" ? createNpmDownloadsConnector(options) : createPyPiDownloadsConnector(options);
    await expect(connector.collect({ package: "tool", ...window })).rejects.toMatchObject({ status: "rate_limited", retryAt: "2026-07-04T00:01:00.000Z" });
    await expect(connector.collect({ package: "tool", ...window })).rejects.toMatchObject({ status: "rate_limited" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
