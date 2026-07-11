import { describe, expect, it } from "vitest";

import {
  admitToLibrary,
  applyCalibration,
  asId,
  buildTrendSeries,
  classifyGitHubMetric,
  createGitHubMetricObservation,
  detectLatestTrendEvent,
  type MetricObservation,
  type Opportunity,
} from "../../src/index.js";

const provenance = {
  collector: "github-fixture",
  collectorVersion: "1",
  interface: "github_rest_api" as const,
  sourceRef: "fixtures/repos.json",
  collectedAt: "2026-07-11T01:00:00.000Z",
};

function observation(id: string, observedAt: string, value: number): MetricObservation {
  return createGitHubMetricObservation({
    id: asId(id),
    subject: {
      kind: "repository",
      externalId: "openai/codex",
      url: "https://github.com/openai/codex",
    },
    metric: "stars",
    observedAt,
    rawValue: value,
    normalizedValue: value,
    provenance,
  });
}

describe("quantitative trend domain", () => {
  it("classifies GitHub popularity only as developer-adoption or supply evidence", () => {
    expect(classifyGitHubMetric("stars")).toBe("developer_adoption");
    expect(classifyGitHubMetric("forks")).toBe("developer_adoption");
    expect(classifyGitHubMetric("contributors")).toBe("developer_adoption");
    expect(classifyGitHubMetric("issue_opened")).toBe("developer_adoption");
    expect(classifyGitHubMetric("issue_closed")).toBe("developer_adoption");
    expect(classifyGitHubMetric("open_issues")).toBe("supply");
    expect(classifyGitHubMetric("repository_count")).toBe("supply");
    expect(classifyGitHubMetric("trending_rank")).toBe("supply");

    const stars = observation("obs_stars", "2026-07-11T00:00:00.000Z", 10);
    expect(stars).toMatchObject({
      source: "github",
      lane: "developer_adoption",
      geography: null,
      unit: "count",
      collectionMethod: "github_rest_api",
    });
    expect(stars).not.toHaveProperty("rawSignalId");
    expect(stars).not.toHaveProperty("supportsClaim");
  });

  it("validates observation values and provenance", () => {
    expect(() => observation("bad", "not-a-date", 1)).toThrow("observedAt");
    expect(() => observation("bad", "2026-07-11T00:00:00.000Z", -1)).toThrow("non-negative");
    expect(() => createGitHubMetricObservation({
      id: asId("bad"),
      subject: { kind: "repository", externalId: "", url: "" },
      metric: "stars",
      observedAt: "2026-07-11T00:00:00.000Z",
      rawValue: 1,
      normalizedValue: 1,
      provenance,
    })).toThrow("subject");
  });

  it("sorts and deduplicates a homogeneous series deterministically", () => {
    const later = observation("obs_2", "2026-07-11T02:00:00.000Z", 15);
    const earlier = observation("obs_1", "2026-07-11T01:00:00.000Z", 10);
    const built = buildTrendSeries(asId("series_codex_stars"), [later, earlier, earlier]);
    expect(built.observations.map((item) => item.id)).toEqual([earlier.id, later.id]);
    expect(built.series).toMatchObject({
      lane: "developer_adoption",
      observationIds: [earlier.id, later.id],
      startedAt: earlier.observedAt,
      endedAt: later.observedAt,
    });

    const forks = createGitHubMetricObservation({ ...later, id: asId("fork"), metric: "forks" });
    expect(() => buildTrendSeries(asId("mixed"), [earlier, forks])).toThrow("share source");
  });

  it("detects a deterministic event with observation provenance", () => {
    const before = observation("obs_before", "2026-07-10T00:00:00.000Z", 100);
    const after = observation("obs_after", "2026-07-11T00:00:00.000Z", 125);
    const { series, observations } = buildTrendSeries(asId("series_codex_stars"), [after, before]);
    const event = detectLatestTrendEvent(
      series,
      new Map(observations.map((item) => [item.id, item])),
      { detectedAt: "2026-07-11T01:00:00.000Z", stableRelativeThreshold: 0.05 },
    );
    expect(event).toMatchObject({
      kind: "momentum_up",
      previousObservationId: before.id,
      currentObservationId: after.id,
      absoluteDelta: 25,
      relativeDelta: 0.25,
      detector: "two_point_delta_v1",
    });
  });

  it("does not let GitHub popularity alone satisfy admission or promotion", () => {
    const popularity = [
      observation("obs_1", "2026-07-09T00:00:00.000Z", 100),
      observation("obs_2", "2026-07-10T00:00:00.000Z", 200),
      observation("obs_3", "2026-07-11T00:00:00.000Z", 400),
    ];
    expect(buildTrendSeries(asId("popular"), popularity).series.lane).toBe("developer_adoption");

    const draft = {
      id: asId("draft_popular"),
      clusterId: asId("cluster_popular"),
      demandStatement: "This popular repository proves user demand",
      persona: "developers",
      scenario: "tooling",
      evidenceItemIds: [],
      disconfirmingSignalIds: [],
      pseudoDemandRisks: ["popularity is not demand"],
      scoreVector: { frequency: 1, crossSource: 1, recency: 1, wtpStrength: 0, workaroundDepth: 0 },
      confidence: "low" as const,
      confidenceReasons: ["github stars"],
      llmModel: "fixture",
      promptVersion: "1",
      provenance: { createdBy: "pipeline" as const },
    };
    const admission = admitToLibrary([draft], new Map(), new Map(), new Map());
    expect(admission.admitted).toEqual([]);
    expect(admission.rejected[0]?.issues[0]?.code).toBe("opportunity.no_evidence_refs");

    const opportunity: Opportunity = {
      id: asId("opp_popular"),
      clusterId: asId("cluster_popular"),
      status: "hypothesis",
      demandStatement: draft.demandStatement,
      persona: draft.persona,
      scenario: draft.scenario,
      evidenceItemIds: [],
      disconfirmingEvidenceItemIds: [],
      pseudoDemandRisks: [...draft.pseudoDemandRisks],
      scoreVector: { ...draft.scoreVector },
      confidence: "low",
      confidenceReasons: ["github momentum_up"],
      provenance: { createdBy: "pipeline", promotedBy: null },
    };
    expect(() => applyCalibration(
      opportunity,
      "promote",
      "popular on GitHub",
      "user",
      undefined,
      { evidenceById: new Map(), chunksById: new Map(), signalsById: new Map() },
    )).toThrow("at least one EvidenceItem");
  });
});
