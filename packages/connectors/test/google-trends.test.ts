import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { asId, buildGoogleTrendSeries, classifySearchMomentum, createGoogleTrendsObservation, type GoogleTrendsNormalizationContext as CoreNormalizationContext } from "@idea-finder/core";

import { createGoogleTrendsConnector } from "../src/connectors/google-trends.js";
import { GoogleTrendsSourceError, type GoogleTrendsTransport } from "../src/ports/google-trends-transport.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
const provenance = {
  transport: "recorded-fixture", transportVersion: "1", authorizedInterface: "recorded_fixture" as const,
  sourceRef: "fixture://google-trends", retrievedAt: "2026-07-11T00:00:00.000Z",
};
const request = {
  subject: "agent tooling", geography: "us", from: "2026-05-01T00:00:00Z",
  to: "2026-07-01T00:00:00Z", granularity: "week" as const,
  category: "all", property: "web" as const,
};
const transport = (fixture: string): GoogleTrendsTransport => ({
  async query() { return { payload: load(fixture), provenance }; },
});

describe("authorized Google Trends connector", () => {
  it("defaults to authorization_required and never attempts private scraping", async () => {
    await expect(createGoogleTrendsConnector().collect(request)).rejects.toMatchObject({
      name: "GoogleTrendsSourceError", status: "authorization_required",
    });
  });

  it.each([
    ["spike", "google-trends-spike.json", 7, request.from, request.to],
    ["seasonal", "google-trends-seasonal.json", 6, request.from, request.to],
    ["sustained", "google-trends-sustained.json", 6, request.from, request.to],
    ["insufficient", "google-trends-insufficient.json", 3, request.from, request.to],
  ])("parses and classifies the recorded %s pattern fixture", async (pattern, fixture, count, from, to) => {
    const result = await createGoogleTrendsConnector({ transport: transport(fixture) }).collect({ ...request, from, to });
    expect(result.observations).toHaveLength(count);
    expect(result.normalizationContext).toMatchObject({
      scale: "relative_0_100", subject: "agent tooling", geography: "US",
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), granularity: "week",
    });
    expect(result.observations.every((item) => item.collectionMethod === "authorized_transport" && item.normalizedValue >= 0 && item.normalizedValue <= 100)).toBe(true);
    expect(new Set(result.observations.map((item) => item.id)).size).toBe(count);
    const context: CoreNormalizationContext = {
      id: asId(`norm_${pattern}`), source: "google_trends", method: "relative_interest_0_100_v1",
      geography: result.normalizationContext.geography,
      window: { startAt: result.normalizationContext.from, endAt: result.normalizationContext.to, resolution: result.normalizationContext.granularity, timezone: "UTC" },
      comparisonSubjects: result.normalizationContext.comparisonSet,
      anchor: result.normalizationContext.anchor,
      category: result.normalizationContext.category, property: result.normalizationContext.property,
      scale: { min: 0, max: 100 }, includesPartialBucket: result.normalizationContext.containsPartialData,
    };
    const observations = result.observations.map((item) => createGoogleTrendsObservation({
      id: asId(item.id), subject: { kind: "search_term", externalId: item.subject, url: item.provenance.sourceRef },
      context, observedAt: item.observedAt, rawValue: item.rawValue, normalizedValue: item.normalizedValue,
      partial: item.partial,
      provenance: { collector: item.provenance.transport, collectorVersion: item.provenance.transportVersion, interface: "recorded_fixture", sourceRef: item.provenance.sourceRef, collectedAt: item.provenance.retrievedAt },
    }));
    const built = buildGoogleTrendSeries(asId(`series_${pattern}`), context, observations);
    const event = classifySearchMomentum(built.series, new Map(observations.map((item) => [item.id, item])), { detectedAt: provenance.retrievedAt });
    expect(event.kind).toBe(pattern === "sustained" ? "sustained_growth" : pattern === "insufficient" ? "insufficient_history" : pattern);
  });

  it("preserves partial and normalization provenance", async () => {
    const result = await createGoogleTrendsConnector({ transport: transport("google-trends-spike.json") }).collect(request);
    expect(result.normalizationContext.containsPartialData).toBe(true);
    expect(result.observations.at(-1)?.partial).toBe(true);
    expect(result.provenance).toEqual(provenance);
    expect(result.observations[0]).not.toHaveProperty("rawBody");
  });

  it("reports unavailable and source drift instead of silent empty observations", async () => {
    await expect(createGoogleTrendsConnector({ transport: transport("google-trends-unavailable.json") }).collect(request))
      .rejects.toMatchObject({ status: "unavailable" });
    await expect(createGoogleTrendsConnector({ transport: transport("google-trends-drift.json") }).collect(request))
      .rejects.toMatchObject({ status: "response_drift" });
  });

  it("validates subject, geography, window, and granularity before transport", async () => {
    const query = vi.fn();
    const connector = createGoogleTrendsConnector({ transport: { query } as GoogleTrendsTransport });
    await expect(connector.collect({ ...request, subject: " " })).rejects.toThrow("subject");
    await expect(connector.collect({ ...request, geography: "USA" })).rejects.toThrow("geography");
    await expect(connector.collect({ ...request, from: request.to })).rejects.toThrow("earlier");
    await expect(connector.collect({ ...request, granularity: "month" as never })).rejects.toThrow("granularity");
    expect(query).not.toHaveBeenCalled();
  });

  it("deduplicates equal rows and fails closed on conflicting duplicates", async () => {
    const equal = { comparisonSet: ["agent tooling"], anchor: null, rows: [
      { time: "2026-06-01T00:00:00Z", value: 10 }, { time: "2026-06-01T00:00:00Z", value: 10 },
    ] };
    const conflicting = { comparisonSet: ["agent tooling"], anchor: null, rows: [
      { time: "2026-06-01T00:00:00Z", value: 10 }, { time: "2026-06-01T00:00:00Z", value: 11 },
    ] };
    const connector = (payload: unknown) => createGoogleTrendsConnector({ transport: { async query() { return { payload, provenance }; } } });
    expect((await connector(equal).collect(request)).observations).toHaveLength(1);
    await expect(connector(conflicting).collect(request)).rejects.toMatchObject({ status: "response_drift" });
  });

  it("preserves typed throttling metadata from an authorized transport", async () => {
    const connector = createGoogleTrendsConnector({ transport: {
      async query() { throw new GoogleTrendsSourceError("throttled", "retry later", "2026-07-11T01:00:00.000Z"); },
    } });
    await expect(connector.collect(request)).rejects.toMatchObject({ status: "throttled", retryAt: "2026-07-11T01:00:00.000Z" });
  });
});
