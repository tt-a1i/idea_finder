import { describe, expect, it } from "vitest";

import {
  admitToLibrary,
  applyCalibration,
  asId,
  buildGoogleTrendSeries,
  classifySearchMomentum,
  createGoogleTrendsObservation,
  type GoogleTrendsMetricObservation,
  type GoogleTrendsNormalizationContext,
  type Opportunity,
} from "../../src/index.js";

function context(overrides: Partial<GoogleTrendsNormalizationContext> = {}): GoogleTrendsNormalizationContext {
  return {
    id: asId("norm_ai_us_2026"),
    source: "google_trends",
    method: "relative_interest_0_100_v1",
    geography: "US",
    window: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-12-31T00:00:00.000Z",
      resolution: "week",
      timezone: "UTC",
    },
    comparisonSubjects: ["ai agent"],
    anchor: null,
    category: "0",
    property: "web",
    scale: { min: 0, max: 100 },
    includesPartialBucket: false,
    ...overrides,
  };
}

const provenance = {
  collector: "google-trends-fixture",
  collectorVersion: "1",
  interface: "recorded_fixture" as const,
  sourceRef: "fixture://google-trends/ai-agent-us",
  collectedAt: "2026-07-11T00:00:00.000Z",
};

function observations(
  values: readonly number[],
  normalization = context(),
): GoogleTrendsMetricObservation[] {
  return values.map((value, index) => createGoogleTrendsObservation({
    id: asId(`gobs_${index}`),
    subject: {
      kind: "search_term",
      externalId: "ai agent",
      url: "https://trends.google.com/trends/explore?q=ai%20agent",
    },
    context: normalization,
    observedAt: `2026-${String(index + 1).padStart(2, "0")}-01T00:00:00.000Z`,
    rawValue: value,
    normalizedValue: value,
    provenance,
  }));
}

function eventFor(values: readonly number[]) {
  const items = observations(values);
  const built = buildGoogleTrendSeries(asId("gseries_ai_agent"), context(), items);
  return classifySearchMomentum(
    built.series,
    new Map(built.observations.map((item) => [item.id, item])),
    { detectedAt: "2026-12-31T01:00:00.000Z" },
  );
}

describe("Google Trends search momentum domain", () => {
  it("pins normalization context, geography, window, and the search-momentum lane", () => {
    const item = observations([0])[0]!;
    expect(item).toMatchObject({
      source: "google_trends",
      metric: "relative_search_interest",
      lane: "search_momentum",
      geography: "US",
      normalizationContextId: "norm_ai_us_2026",
      unit: "relative_interest_0_100",
      collectionMethod: "recorded_fixture",
      partial: false,
    });
    expect(item).not.toHaveProperty("supportsClaim");
    expect(item).not.toHaveProperty("rawSignalId");

    expect(() => observations([101])).toThrow("between 0 and 100");
    expect(() => observations([1], context({ geography: "" }))).toThrow("geography");
    expect(() => observations([1], context({ window: { ...context().window, startAt: context().window.endAt } }))).toThrow("must precede");
    expect(() => observations([1], context({ comparisonSubjects: ["other"] }))).toThrow("comparisonSubjects");
    expect(() => observations([1], context({ anchor: " " }))).toThrow("anchor");
  });

  it("does not mix normalization contexts, geographies, or comparison windows", () => {
    const us = observations([10, 20]);
    const gbContext = context({ id: asId("norm_ai_gb"), geography: "GB" });
    const gb = observations([10], gbContext)[0]!;
    expect(() => buildGoogleTrendSeries(asId("mixed"), context(), [...us, gb]))
      .toThrow("cannot mix");

    const otherWindow = context({
      id: asId("norm_ai_us_other_window"),
      window: { ...context().window, endAt: "2026-11-30T00:00:00.000Z" },
    });
    expect(() => buildGoogleTrendSeries(asId("mixed"), context(), [...us, observations([10], otherWindow)[0]!]))
      .toThrow("cannot mix");
  });

  it.each([
    ["spike", [10, 10, 10, 80, 12, 10]],
    ["seasonal", [10, 50, 10, 12, 55, 12]],
    ["sustained_growth", [10, 15, 20, 30, 45, 65]],
    ["insufficient_history", [10, 20, 30]],
    ["no_pattern", [20, 22, 21, 23, 22, 24]],
  ] as const)("classifies %s deterministically", (kind, values) => {
    const event = eventFor(values);
    expect(event.kind).toBe(kind);
    expect(event.detector).toBe("search_momentum_v1");
    expect(event.rules).toMatchObject({ minHistoryBuckets: 6, seasonalPeriodBuckets: 3 });
  });

  it("excludes partial buckets and exposes insufficient history instead of silent empty output", () => {
    const normalization = context({ includesPartialBucket: true });
    const complete = observations([10, 20, 30, 40, 50], normalization);
    const partial = createGoogleTrendsObservation({
      id: asId("partial"),
      subject: complete[0]!.subject,
      context: normalization,
      observedAt: "2026-06-01T00:00:00.000Z",
      rawValue: 100,
      normalizedValue: 100,
      partial: true,
      provenance,
    });
    const built = buildGoogleTrendSeries(asId("partial_series"), normalization, [...complete, partial]);
    const event = classifySearchMomentum(
      built.series,
      new Map(built.observations.map((item) => [item.id, item])),
      { detectedAt: "2026-07-11T00:00:00.000Z" },
    );
    expect(event.kind).toBe("insufficient_history");
    expect(event.observationIds).not.toContain(partial.id);
  });

  it("does not let maximal search momentum satisfy admission or promotion", () => {
    expect(eventFor([10, 20, 30, 50, 75, 100]).kind).toBe("sustained_growth");
    const draft = {
      id: asId("draft_search_momentum"), clusterId: asId("cluster_search_momentum"),
      demandStatement: "Search growth proves demand", persona: "searchers", scenario: "research",
      evidenceItemIds: [], disconfirmingSignalIds: [], pseudoDemandRisks: ["search interest is not demand"],
      scoreVector: { frequency: 1, crossSource: 1, recency: 1, wtpStrength: 0, workaroundDepth: 0 },
      confidence: "low" as const, confidenceReasons: ["google trends growth"], llmModel: "fixture",
      promptVersion: "1", provenance: { createdBy: "pipeline" as const },
    };
    const admission = admitToLibrary([draft], new Map(), new Map(), new Map());
    expect(admission.admitted).toEqual([]);
    expect(admission.rejected[0]?.issues[0]?.code).toBe("opportunity.no_evidence_refs");

    const opportunity: Opportunity = {
      id: asId("opp_search_momentum"), clusterId: draft.clusterId, status: "hypothesis",
      demandStatement: draft.demandStatement, persona: draft.persona, scenario: draft.scenario,
      evidenceItemIds: [], disconfirmingEvidenceItemIds: [], pseudoDemandRisks: [...draft.pseudoDemandRisks],
      scoreVector: { ...draft.scoreVector }, confidence: "low", confidenceReasons: [...draft.confidenceReasons],
      provenance: { createdBy: "pipeline", promotedBy: null },
    };
    expect(() => applyCalibration(opportunity, "promote", "trending", "user", undefined, {
      evidenceById: new Map(), chunksById: new Map(), signalsById: new Map(),
    })).toThrow("at least one EvidenceItem");
  });
});
