import { describe, expect, it } from "vitest";

import {
  admitToLibrary,
  applyCalibration,
  asId,
  buildExactDuplicateIndependenceIndex,
  buildMultiLaneSummary,
  buildResearchClaim,
  evaluateMultiLaneCandidate,
  independentEvidenceGroupIds,
  proposeFollowUpHuntingTask,
  type Chunk,
  type EvidenceItem,
  type OpportunityDraft,
  type RawSignal,
  type ResearchClaim,
} from "../../src/index.js";

function qualitativeFixture(contents: readonly string[]) {
  const chunks = contents.map((content, index): Chunk => ({
    id: asId(`chunk_${index}`), documentId: asId(`doc_${index}`), text: content, spanStart: 0, spanEnd: content.length,
  }));
  const signals = chunks.map((chunk, index): RawSignal => ({
    id: asId(`signal_${index}`), chunkId: chunk.id, documentId: chunk.documentId,
    signalType: "pain", signalSubtype: "manual", quoteVerbatim: chunk.text,
    quoteHash: `hash_${index}`, spanStart: 0, spanEnd: chunk.text.length,
    confidenceRule: 1, detector: "rule_v1", detectorVersion: "1", extractedAt: "2026-07-11T00:00:00.000Z",
  }));
  const evidence = chunks.map((chunk, index): EvidenceItem => ({
    id: asId(`evidence_${index}`), clusterId: asId("cluster_multi"), opportunityId: null,
    rawSignalId: signals[index]!.id, documentId: chunk.documentId, chunkId: chunk.id,
    platform: `source_${index}`, url: `https://example.test/${index}`, linkStatus: "ok",
    quoteVerbatim: chunk.text, supportsClaim: "pain", strength: "primary", userVerified: true,
    provenance: { createdBy: "pipeline", agentRunId: null }, fetchedAt: "2026-07-11T00:00:00.000Z",
  }));
  const draft: OpportunityDraft = {
    id: asId("draft_multi"), clusterId: asId("cluster_multi"), demandStatement: "Teams repeatedly report this pain",
    persona: "teams", scenario: "workflow", evidenceItemIds: evidence.map((item) => item.id), disconfirmingSignalIds: [],
    pseudoDemandRisks: [], scoreVector: { frequency: 1, crossSource: 1, recency: 1, wtpStrength: 0, workaroundDepth: 0 },
    confidence: "medium", confidenceReasons: ["qualitative"], llmModel: "fixture", promptVersion: "1",
    provenance: { createdBy: "pipeline" },
  };
  const independence = buildExactDuplicateIndependenceIndex(contents.map((content, index) => ({
    documentId: asId(`doc_${index}`),
    content,
    platform: `source_${index}`,
    url: `https://example.test/${index}`,
  })));
  return {
    chunks, signals, evidence, draft, independence,
    evidenceById: new Map(evidence.map((item) => [item.id, item])),
    chunksById: new Map(chunks.map((item) => [item.id, item])),
    signalsById: new Map(signals.map((item) => [item.id, item])),
  };
}

describe("multi-lane research domain", () => {
  it("builds claims with stored evidence references and no opaque score", () => {
    const text = buildResearchClaim({
      id: "claim_pain", lane: "qualitative_demand", statement: "Teams report painful reconciliation", status: "validated",
      evidenceRefs: [{ kind: "text_quote", evidenceItemId: asId("evidence_1"), chunkId: "chunk_1", documentId: asId("doc_1"), url: "https://example.test/1" }],
      independentSourceGroupIds: ["group_b", "group_a", "group_a"], limitations: [],
    });
    expect(text.independentSourceGroupIds).toEqual(["group_a", "group_b"]);
    expect(text).not.toHaveProperty("score");
    expect(() => buildResearchClaim({ ...text, id: "missing", evidenceRefs: [] })).toThrow("evidence");
    expect(() => buildResearchClaim({ ...text, id: "trend", lane: "trend_momentum" })).toThrow("series");
  });

  it("keeps quantitative-only candidates visibly unvalidated and summaries lane-separated", () => {
    const trend = buildResearchClaim({
      id: "claim_trend", lane: "trend_momentum", statement: "Search interest spiked", status: "unvalidated",
      evidenceRefs: [{ kind: "observation_series", seriesId: asId("series_search"), observationIds: [asId("obs_1")] }],
      independentSourceGroupIds: [], limitations: ["Momentum is not demand validation"],
    });
    const candidate = evaluateMultiLaneCandidate({
      id: "candidate_trend", subject: "agent coding", claims: [trend], qualitativeEvidenceItemIds: [],
      quantitativeSeriesIds: [asId("series_search")], independentQualitativeSourceGroupIds: [],
    });
    expect(candidate).toMatchObject({ status: "unvalidated", validationIssues: expect.arrayContaining([expect.objectContaining({ code: "candidate.qualitative_demand_missing" })]) });
    const summary = buildMultiLaneSummary({ briefId: asId("brief_1"), runId: "run_1", claims: [trend], candidates: [candidate] });
    expect(summary.schemaVersion).toBe("1");
    expect(summary.lanes.trend_momentum).toMatchObject({ totalClaims: 1, unvalidatedClaims: 1 });
    expect(summary.lanes.qualitative_demand.totalClaims).toBe(0);
    expect(summary).not.toHaveProperty("score");
  });

  it("groups normalized exact duplicates and makes the new gate fail closed", () => {
    const duplicate = qualitativeFixture([
      "The workflow is painfully manual.",
      "  The workflow is painfully   manual.  ",
      "The workflow is painfully manual.\n",
    ]);
    expect(new Set(duplicate.independence.records.map((item) => item.independenceGroupId)).size).toBe(1);
    expect(independentEvidenceGroupIds(duplicate.evidence, duplicate.independence)).toHaveLength(1);
    const result = admitToLibrary(
      [duplicate.draft], duplicate.evidenceById, duplicate.chunksById, duplicate.signalsById,
      duplicate.independence,
    );
    expect(result.admitted).toEqual([]);
    expect(result.rejected[0]?.issues.map((issue) => issue.code)).toContain("opportunity.insufficient_evidence");

    const missing = { independenceGroupByDocumentId: new Map([[asId("doc_0"), "one"]]) };
    const missingResult = admitToLibrary([duplicate.draft], duplicate.evidenceById, duplicate.chunksById, duplicate.signalsById, missing);
    expect(missingResult.rejected[0]?.issues.map((issue) => issue.code)).toContain("independence.metadata_missing");
  });

  it("admits independently corroborated evidence and applies the same gate to promotion", () => {
    const fixture = qualitativeFixture(["Pain report one", "Pain report two", "Pain report three"]);
    const admission = admitToLibrary([fixture.draft], fixture.evidenceById, fixture.chunksById, fixture.signalsById, fixture.independence);
    expect(admission.admitted).toHaveLength(1);
    const opportunity = admission.admitted[0]!;
    const promoted = applyCalibration(opportunity, "promote", "independently corroborated", "user", undefined, {
      evidenceById: fixture.evidenceById, chunksById: fixture.chunksById, signalsById: fixture.signalsById,
      corroborationContext: fixture.independence,
    });
    expect(promoted.opportunity.status).toBe("promoted");

    const duplicateContext = buildExactDuplicateIndependenceIndex(fixture.chunks.map((chunk) => ({
      documentId: chunk.documentId,
      content: "same syndicated copy",
      platform: "hn",
      url: `https://example.test/${chunk.documentId}`,
    })));
    expect(() => applyCalibration(opportunity, "promote", "syndicated", "user", undefined, {
      evidenceById: fixture.evidenceById, chunksById: fixture.chunksById, signalsById: fixture.signalsById,
      corroborationContext: duplicateContext,
    })).toThrow("at least 3");
  });

  it("proposes a deterministic qualitative follow-up without creating an opportunity", () => {
    const proposal = proposeFollowUpHuntingTask({
      triggerEventId: asId("event_spike"), triggerSeriesId: asId("series_search"), triggerKind: "spike", subject: "agent coding",
    });
    expect(proposal).toMatchObject({
      status: "proposed",
      requiredLanes: ["qualitative_demand", "supply_competition", "commercial_intent"],
      suggestedLenses: ["pain", "workaround", "competition", "commercial_intent"],
    });
    expect(proposal).not.toHaveProperty("opportunityId");
    expect(proposeFollowUpHuntingTask({ triggerEventId: asId("event_spike"), triggerSeriesId: asId("series_search"), triggerKind: "spike", subject: "agent coding" }).id).toBe(proposal.id);
  });

  it("collapses distinct manual imports without explicit provenance into one independence group", () => {
    const texts = [
      "Standup notes get lost between coding agents every Monday.",
      "We paste the same handoff workaround into Slack each week.",
      "Would pay for a durable agent coordination inbox.",
    ];
    const independence = buildExactDuplicateIndependenceIndex(texts.map((content, index) => ({
      documentId: asId(`doc_manual_${index}`),
      content,
      platform: "manual",
      url: `manual://import/hash${index}`,
    })));
    expect(new Set(independence.records.map((item) => item.independenceGroupId)).size).toBe(1);
    expect(independence.records.filter((item) => item.relation === "same_provenance")).toHaveLength(2);
    expect(independence.records.some((item) => item.basis === "manual_shared_provenance_v1")).toBe(true);

    const evidence = texts.map((content, index): EvidenceItem => ({
      id: asId(`evidence_manual_${index}`), clusterId: asId("cluster_manual"), opportunityId: null,
      rawSignalId: asId(`signal_manual_${index}`), documentId: asId(`doc_manual_${index}`), chunkId: asId(`chunk_manual_${index}`),
      platform: "manual", url: `manual://import/hash${index}`, linkStatus: "ok",
      quoteVerbatim: content, supportsClaim: "pain", strength: "primary", userVerified: true,
      provenance: { createdBy: "pipeline", agentRunId: null }, fetchedAt: "2026-07-11T00:00:00.000Z",
    }));
    const draft: OpportunityDraft = {
      id: asId("draft_manual_only"), clusterId: asId("cluster_manual"), demandStatement: "Agent coordination is painful",
      persona: "teams", scenario: "handoff", evidenceItemIds: evidence.map((item) => item.id), disconfirmingSignalIds: [],
      pseudoDemandRisks: [], scoreVector: { frequency: 1, crossSource: 1, recency: 1, wtpStrength: 1, workaroundDepth: 1 },
      confidence: "medium", confidenceReasons: ["manual"], llmModel: "fixture", promptVersion: "1",
      provenance: { createdBy: "pipeline" },
    };
    const admission = admitToLibrary(
      [draft],
      new Map(evidence.map((item) => [item.id, item])),
      new Map(texts.map((content, index) => [asId(`chunk_manual_${index}`), {
        id: asId(`chunk_manual_${index}`), documentId: asId(`doc_manual_${index}`), text: content, spanStart: 0, spanEnd: content.length,
      }])),
      new Map(texts.map((content, index) => [asId(`signal_manual_${index}`), {
        id: asId(`signal_manual_${index}`), chunkId: asId(`chunk_manual_${index}`), documentId: asId(`doc_manual_${index}`),
        signalType: "pain", signalSubtype: "manual", quoteVerbatim: content, quoteHash: `hash_${index}`,
        spanStart: 0, spanEnd: content.length, confidenceRule: 1, detector: "rule_v1", detectorVersion: "1",
        extractedAt: "2026-07-11T00:00:00.000Z",
      }])),
      independence,
    );
    expect(admission.admitted).toEqual([]);
    expect(admission.rejected[0]?.issues.map((issue) => issue.code)).toContain("opportunity.insufficient_evidence");
  });

  it("keeps manual imports with distinct explicit URLs as independent source groups", () => {
    const independence = buildExactDuplicateIndependenceIndex([
      { documentId: asId("doc_a"), content: "Interview note A about painful handoffs", platform: "manual", url: "https://notes.example/a" },
      { documentId: asId("doc_b"), content: "Interview note B about weekly workarounds", platform: "manual", url: "https://notes.example/b" },
      { documentId: asId("doc_c"), content: "Interview note C about willingness to pay", platform: "manual", url: "https://notes.example/c" },
    ]);
    expect(new Set(independence.records.map((item) => item.independenceGroupId)).size).toBe(3);
  });

  it("merges provenance-less manuals without collapsing independent public sources", () => {
    const independence = buildExactDuplicateIndependenceIndex([
      { documentId: asId("doc_m1"), content: "Manual note one about agent pain", platform: "manual", url: "manual://import/aaa" },
      { documentId: asId("doc_m2"), content: "Manual note two about agent pain", platform: "manual", url: "manual://import/bbb" },
      { documentId: asId("doc_hn"), content: "HN thread about agent coding coordination", platform: "hn", url: "https://news.ycombinator.com/item?id=1" },
    ]);
    expect(new Set(independence.records.map((item) => item.independenceGroupId)).size).toBe(2);
    const manualGroups = independence.records.filter((item) => String(item.documentId).startsWith("doc_m"));
    expect(new Set(manualGroups.map((item) => item.independenceGroupId)).size).toBe(1);
  });
});
