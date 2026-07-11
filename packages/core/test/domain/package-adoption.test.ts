import { describe, expect, it } from "vitest";

import {
  admitToLibrary,
  applyCalibration,
  asId,
  buildPackageDownloadSeries,
  canonicalizePackageName,
  createPackageDownloadObservation,
  createPackageSubject,
  detectLatestPackageDownloadEvent,
  type Opportunity,
  type PackageDownloadObservation,
  type PackageEcosystem,
} from "../../src/index.js";

const provenance = {
  collector: "package-fixture",
  collectorVersion: "1",
  interface: "recorded_fixture" as const,
  sourceRef: "fixture://package-downloads",
  collectedAt: "2026-07-11T00:00:00.000Z",
  caveat: "Recorded fixture",
};

function observation(
  ecosystem: PackageEcosystem,
  packageName: string,
  index: number,
  downloads: number,
  coverageDays = 7,
): PackageDownloadObservation {
  const start = new Date(Date.UTC(2026, 0, 1 + index * 7));
  const end = new Date(Date.UTC(2026, 0, 1 + (index + 1) * 7));
  return createPackageDownloadObservation({
    id: asId(`pobs_${ecosystem}_${index}`),
    ecosystem,
    packageName,
    bucket: {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      resolution: "week",
      timezone: "UTC",
      coverageDays,
      partial: false,
    },
    downloads,
    provenance,
  });
}

describe("package adoption domain", () => {
  it("canonicalizes npm names/scopes and PyPI names without conflating ecosystems", () => {
    expect(canonicalizePackageName("npm", "react")).toBe("react");
    expect(canonicalizePackageName("npm", "@openai/codex")).toBe("@openai/codex");
    expect(() => canonicalizePackageName("npm", "React")).toThrow("lowercase");
    expect(() => canonicalizePackageName("npm", "@scope")).toThrow("@scope/name");
    expect(() => canonicalizePackageName("npm", "scope/name")).toThrow("Invalid npm");

    expect(canonicalizePackageName("pypi", "Foo_Bar")).toBe("foo-bar");
    expect(canonicalizePackageName("pypi", "foo.bar")).toBe("foo-bar");
    expect(canonicalizePackageName("pypi", "foo---bar")).toBe("foo-bar");
    expect(() => canonicalizePackageName("pypi", "-foo-")).toThrow("Invalid PyPI");

    const npm = createPackageSubject("npm", "requests");
    const pypi = createPackageSubject("pypi", "requests");
    expect(npm.externalId).toBe("npm:requests");
    expect(pypi.externalId).toBe("pypi:requests");
    expect(npm.externalId).not.toBe(pypi.externalId);
  });

  it("computes downloads-per-day and fixes source, metric, and lane", () => {
    const npm = observation("npm", "@openai/codex", 0, 700);
    expect(npm).toMatchObject({
      source: "npm_registry",
      ecosystem: "npm",
      metric: "downloads",
      lane: "developer_adoption",
      rawValue: 700,
      normalizedValue: 100,
      normalizationMethod: "bucket_count_to_daily_rate_v1",
      unit: "downloads_per_day",
      observedAt: npm.bucket.endAt,
    });
    expect(npm).not.toHaveProperty("supportsClaim");
    expect(() => observation("npm", "react", 0, -1)).toThrow("non-negative integer");
    expect(() => observation("npm", "react", 0, 1, 0)).toThrow("coverageDays");
  });

  it("builds only contiguous homogeneous series and derives a reproducible event", () => {
    const first = observation("pypi", "Foo_Bar", 0, 70);
    const second = observation("pypi", "foo.bar", 1, 140);
    const built = buildPackageDownloadSeries(asId("pseries_pypi_foo_bar"), [second, first]);
    expect(built.series).toMatchObject({
      ecosystem: "pypi",
      subject: { canonicalName: "foo-bar", externalId: "pypi:foo-bar" },
      observationIds: [first.id, second.id],
      normalizationMethod: "bucket_count_to_daily_rate_v1",
    });
    const event = detectLatestPackageDownloadEvent(
      built.series,
      new Map(built.observations.map((item) => [item.id, item])),
      { detectedAt: "2026-07-11T00:00:00.000Z", stableRelativeThreshold: 0.05 },
    );
    expect(event).toMatchObject({
      kind: "momentum_up",
      previousValue: 10,
      currentValue: 20,
      absoluteDelta: 10,
      relativeDelta: 1,
      detector: "package_download_delta_v1",
      stableRelativeThreshold: 0.05,
    });

    expect(() => buildPackageDownloadSeries(asId("mixed"), [first, observation("npm", "foo-bar", 1, 140)]))
      .toThrow("cannot mix ecosystem");
    const gap = createPackageDownloadObservation({
      id: asId("gap"), ecosystem: "pypi", packageName: "foo-bar", downloads: 1, provenance,
      bucket: { ...second.bucket, startAt: "2026-02-01T00:00:00.000Z", endAt: "2026-02-08T00:00:00.000Z" },
    });
    expect(() => buildPackageDownloadSeries(asId("gap"), [first, gap])).toThrow("contiguous");
  });

  it("does not let npm and PyPI popularity satisfy admission or promotion", () => {
    const packageMomentum = [
      observation("npm", "requests", 0, 7_000_000),
      observation("pypi", "requests", 0, 70_000_000),
    ];
    expect(packageMomentum.every((item) => item.lane === "developer_adoption")).toBe(true);
    const draft = {
      id: asId("draft_package_popularity"), clusterId: asId("cluster_package_popularity"),
      demandStatement: "Downloads prove demand", persona: "developers", scenario: "dependency selection",
      evidenceItemIds: [], disconfirmingSignalIds: [], pseudoDemandRisks: ["adoption is not demand"],
      scoreVector: { frequency: 1, crossSource: 1, recency: 1, wtpStrength: 0, workaroundDepth: 0 },
      confidence: "low" as const, confidenceReasons: ["package downloads"], llmModel: "fixture",
      promptVersion: "1", provenance: { createdBy: "pipeline" as const },
    };
    const admission = admitToLibrary([draft], new Map(), new Map(), new Map());
    expect(admission.admitted).toEqual([]);
    expect(admission.rejected[0]?.issues[0]?.code).toBe("opportunity.no_evidence_refs");

    const opportunity: Opportunity = {
      id: asId("opp_package_popularity"), clusterId: draft.clusterId, status: "hypothesis",
      demandStatement: draft.demandStatement, persona: draft.persona, scenario: draft.scenario,
      evidenceItemIds: [], disconfirmingEvidenceItemIds: [], pseudoDemandRisks: [...draft.pseudoDemandRisks],
      scoreVector: { ...draft.scoreVector }, confidence: "low", confidenceReasons: [...draft.confidenceReasons],
      provenance: { createdBy: "pipeline", promotedBy: null },
    };
    expect(() => applyCalibration(opportunity, "promote", "popular package", "user", undefined, {
      evidenceById: new Map(), chunksById: new Map(), signalsById: new Map(),
    })).toThrow("at least one EvidenceItem");
  });
});
