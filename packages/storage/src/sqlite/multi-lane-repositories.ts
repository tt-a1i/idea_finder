import type { DatabaseSync } from "node:sqlite";
import {
  buildResearchClaim,
  buildMultiLaneSummary,
  buildExactDuplicateIndependenceIndex,
  proposeFollowUpHuntingTask,
  type EvidenceIndependenceRecord,
  type FollowUpHuntingTaskProposal,
  type ResearchRun,
  type TrendEvent,
  type TrendSeries,
} from "@idea-finder/core";
import type {
  EvidenceIndependenceRepository,
  FollowUpProposalRepository,
  MultiLaneReportRepository,
  StoredMultiLaneReportRecord,
} from "../ports/repositories.js";

function parse<T>(row: { payload_json: string } | undefined): T | null {
  return row ? JSON.parse(row.payload_json) as T : null;
}

function assertSame<T>(existing: T | null, incoming: T, label: string): void {
  if (existing && JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(`${label} conflicts with canonical SQLite state`);
  }
}

function requireRun(db: DatabaseSync, runId: string): ResearchRun {
  const row = db.prepare("SELECT * FROM research_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Missing ResearchRun ${runId}`);
  return {
    id: row.id as ResearchRun["id"], huntingTaskId: row.hunting_task_id as ResearchRun["huntingTaskId"],
    status: row.status as ResearchRun["status"], startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null, configHash: row.config_hash as string,
    errorMessage: row.error_message as string | null,
  };
}

export function createMultiLaneReportRepository(db: DatabaseSync): MultiLaneReportRepository {
  const insert = db.prepare("INSERT INTO multi_lane_reports (run_id, brief_id, payload_json) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET brief_id=excluded.brief_id, payload_json=excluded.payload_json");
  const get = db.prepare("SELECT payload_json FROM multi_lane_reports WHERE run_id = ?");
  const insertClaim = db.prepare("INSERT OR IGNORE INTO multi_lane_report_claims (run_id, claim_id) VALUES (?, ?)");
  const claimRuns = db.prepare("SELECT run_id FROM multi_lane_report_claims WHERE claim_id = ? ORDER BY run_id");
  const getSeries = db.prepare("SELECT payload_json FROM trend_series WHERE id = ?");
  const getObservation = db.prepare("SELECT payload_json FROM metric_observations WHERE id = ?");
  const getEvidence = db.prepare("SELECT payload_json FROM evidence_items WHERE research_run_id = ? AND id = ?");
  const getChunk = db.prepare("SELECT payload_json FROM chunks WHERE research_run_id = ? AND id = ?");
  const getDocument = db.prepare("SELECT 1 AS found FROM raw_documents WHERE research_run_id = ? AND id = ?");
  const getIndependence = db.prepare("SELECT payload_json FROM evidence_independence WHERE run_id = ? AND document_id = ?");
  const getProposal = db.prepare("SELECT 1 AS found FROM follow_up_proposals WHERE run_id = ? AND id = ?");
  return {
    save(record) {
      const run = requireRun(db, record.runId);
      if (record.id !== record.runId || record.summary.runId !== record.runId ||
        record.briefId !== record.summary.briefId || record.briefId !== run.huntingTaskId) {
        throw new Error(`MultiLaneReport ${record.id} identity conflicts with its ResearchRun`);
      }
      const claims = record.claims.map((claim) => buildResearchClaim(claim));
      if (new Set(claims.map((claim) => claim.id)).size !== claims.length) throw new Error(`MultiLaneReport ${record.id} has duplicate claim IDs`);
      for (const claim of claims) {
        const expectedGroups = new Set<string>();
        for (const ref of claim.evidenceRefs) {
        if (ref.kind === "observation_series") {
          const series = parse<TrendSeries>(getSeries.get(ref.seriesId) as { payload_json: string } | undefined);
          const snapshot = record.seriesSnapshots.find((item) => item.id === ref.seriesId);
          if (!series || !snapshot || JSON.stringify(series) !== JSON.stringify(snapshot) || ref.observationIds.some((id) => {
            const observationSnapshot = record.observationSnapshots.find((item) => item.id === id);
            const live = parse(getObservation.get(id) as { payload_json: string } | undefined);
            return !snapshot.observationIds.includes(id) || !observationSnapshot || JSON.stringify(live) !== JSON.stringify(observationSnapshot);
          })) throw new Error(`ResearchClaim ${claim.id} has invalid series snapshot references`);
        } else if (ref.kind === "ranking_snapshot") {
          const snapshot = record.observationSnapshots.find((item) => item.id === ref.observationId);
          const live = parse(getObservation.get(ref.observationId) as { payload_json: string } | undefined);
          if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(live)) throw new Error(`ResearchClaim ${claim.id} references missing observation ${ref.observationId}`);
        } else if (ref.kind === "text_quote") {
          const evidence = parse<{ documentId: string; chunkId: string; quoteVerbatim: string; url: string }>(getEvidence.get(record.runId, ref.evidenceItemId) as { payload_json: string } | undefined);
          const chunk = parse<{ text: string }>(getChunk.get(record.runId, ref.chunkId) as { payload_json: string } | undefined);
          if (!evidence || evidence.documentId !== ref.documentId || evidence.chunkId !== ref.chunkId ||
            evidence.url !== ref.url || !chunk?.text.includes(evidence.quoteVerbatim) || !getDocument.get(record.runId, ref.documentId)) {
            throw new Error(`ResearchClaim ${claim.id} has invalid text evidence references`);
          }
          const independence = parse<EvidenceIndependenceRecord>(getIndependence.get(record.runId, ref.documentId) as { payload_json: string } | undefined);
          if (!independence) throw new Error(`ResearchClaim ${claim.id} references missing independence metadata`);
          expectedGroups.add(independence.independenceGroupId);
        }
        }
        if (JSON.stringify([...expectedGroups].sort()) !== JSON.stringify([...claim.independentSourceGroupIds].sort())) {
          throw new Error(`ResearchClaim ${claim.id} independence groups conflict with referenced evidence`);
        }
      }
      const candidateIds = record.summary.candidates.map((candidate) => candidate.id);
      if (JSON.stringify(candidateIds) !== JSON.stringify(record.candidateIds)) throw new Error(`MultiLaneReport ${record.id} candidate IDs conflict with summary`);
      const claimIds = new Set(claims.map((claim) => claim.id));
      for (const candidate of record.summary.candidates) {
        if (candidate.claimIds.some((id) => !claimIds.has(id))) throw new Error(`Candidate ${candidate.id} references missing claim`);
        if (candidate.qualitativeEvidenceItemIds.some((id) => !getEvidence.get(record.runId, id))) throw new Error(`Candidate ${candidate.id} references missing qualitative evidence`);
        if (candidate.quantitativeSeriesIds.some((id) => {
          const live = parse<TrendSeries>(getSeries.get(id) as { payload_json: string } | undefined);
          const snapshot = record.seriesSnapshots.find((item) => item.id === id);
          return !live || !snapshot || JSON.stringify(live) !== JSON.stringify(snapshot);
        })) throw new Error(`Candidate ${candidate.id} references missing quantitative series`);
      }
      if (record.summary.followUpProposalIds.some((id) => !getProposal.get(record.runId, id))) {
        throw new Error(`MultiLaneReport ${record.id} references missing follow-up proposal`);
      }
      const expectedSummary = buildMultiLaneSummary({
        briefId: record.briefId as never,
        runId: record.runId,
        claims,
        candidates: record.summary.candidates,
        followUpProposalIds: record.summary.followUpProposalIds,
      });
      if (JSON.stringify(record.summary) !== JSON.stringify(expectedSummary)) {
        throw new Error(`MultiLaneReport ${record.id} summary conflicts with claims and proposals`);
      }
      const canonical = { ...record, claims };
      insert.run(record.runId, record.briefId, JSON.stringify(canonical));
      assertSame(parse(get.get(record.runId) as { payload_json: string } | undefined), canonical, `MultiLaneReport ${record.runId}`);
      for (const claim of claims) insertClaim.run(record.runId, claim.id);
    },
    getByRun(runId) { return parse(get.get(runId) as { payload_json: string } | undefined); },
    listByClaim(claimId) {
      return (claimRuns.all(claimId) as Array<{ run_id: string }>).flatMap((row) => parse<StoredMultiLaneReportRecord>(get.get(row.run_id) as { payload_json: string } | undefined) ?? []);
    },
  };
}

export function createEvidenceIndependenceRepository(db: DatabaseSync): EvidenceIndependenceRepository {
  const insert = db.prepare(`INSERT INTO evidence_independence
    (run_id, document_id, independence_group_id, content_fingerprint, payload_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const get = db.prepare("SELECT payload_json FROM evidence_independence WHERE run_id = ? AND document_id = ?");
  const listRun = db.prepare("SELECT payload_json FROM evidence_independence WHERE run_id = ? ORDER BY document_id");
  const listGroup = db.prepare("SELECT payload_json FROM evidence_independence WHERE run_id = ? AND independence_group_id = ? ORDER BY document_id");
  const getDocument = db.prepare("SELECT 1 AS found FROM raw_documents WHERE research_run_id = ? AND id = ?");
  const listDocuments = db.prepare("SELECT payload_json FROM raw_documents WHERE research_run_id = ? ORDER BY id");
  return {
    saveIndex(runId, records) {
      requireRun(db, runId);
      const documents = (listDocuments.all(runId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as { id: string; rawBody: string; platform?: string; url?: string });
      const expected = buildExactDuplicateIndependenceIndex(documents.map((document) => ({
        documentId: document.id as never,
        content: document.rawBody,
        platform: document.platform,
        url: document.url,
      }))).records;
      if (JSON.stringify(expected) !== JSON.stringify(records)) throw new Error(`Evidence independence index ${runId} conflicts with canonical documents`);
      for (const record of records) {
        insert.run(runId, record.documentId, record.independenceGroupId, record.contentFingerprint, JSON.stringify(record));
        assertSame(parse(get.get(runId, record.documentId) as { payload_json: string } | undefined), record, `EvidenceIndependence ${runId}/${record.documentId}`);
      }
    },
    save(runId, record) {
      requireRun(db, runId);
      const documents = (listDocuments.all(runId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as { id: string; rawBody: string; platform?: string; url?: string });
      const expected = buildExactDuplicateIndependenceIndex(documents.map((document) => ({
        documentId: document.id as never,
        content: document.rawBody,
        platform: document.platform,
        url: document.url,
      }))).records.find((item) => item.documentId === record.documentId);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(record)) throw new Error(`EvidenceIndependence ${runId}/${record.documentId} conflicts with canonical documents`);
      if (!record.contentFingerprint.trim() || !record.independenceGroupId.trim() || !getDocument.get(runId, record.documentId) || !getDocument.get(runId, record.canonicalDocumentId)) {
        throw new Error(`EvidenceIndependence ${runId}/${record.documentId} has invalid document references`);
      }
      if ((record.documentId === record.canonicalDocumentId) !== (record.relation === "independent")) {
        throw new Error(`EvidenceIndependence ${runId}/${record.documentId} relation conflicts with canonical document`);
      }
      const group = listGroup.all(runId, record.independenceGroupId) as Array<{ payload_json: string }>;
      for (const row of group) {
        const member = JSON.parse(row.payload_json) as EvidenceIndependenceRecord;
        if (member.canonicalDocumentId !== record.canonicalDocumentId) {
          throw new Error(`Evidence independence group ${record.independenceGroupId} conflicts with canonical SQLite state`);
        }
      }
      insert.run(runId, record.documentId, record.independenceGroupId, record.contentFingerprint, JSON.stringify(record));
      assertSame(parse(get.get(runId, record.documentId) as { payload_json: string } | undefined), record, `EvidenceIndependence ${runId}/${record.documentId}`);
    },
    getByDocument(runId, documentId) { return parse(get.get(runId, documentId) as { payload_json: string } | undefined); },
    listByRun(runId) { return (listRun.all(runId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as EvidenceIndependenceRecord); },
    listByGroup(runId, groupId) { return (listGroup.all(runId, groupId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as EvidenceIndependenceRecord); },
  };
}

export function createFollowUpProposalRepository(db: DatabaseSync): FollowUpProposalRepository {
  const insert = db.prepare(`INSERT INTO follow_up_proposals
    (run_id, id, trigger_series_id, trigger_event_id, payload_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, id) DO UPDATE SET payload_json=excluded.payload_json`);
  const get = db.prepare("SELECT payload_json FROM follow_up_proposals WHERE run_id = ? AND id = ?");
  const list = db.prepare("SELECT payload_json FROM follow_up_proposals WHERE run_id = ? ORDER BY id");
  const getSeries = db.prepare("SELECT 1 AS found FROM trend_series WHERE id = ?");
  const getEvent = db.prepare("SELECT payload_json FROM trend_events WHERE id = ?");
  const getBrief = db.prepare("SELECT payload_json FROM hunting_briefs WHERE id = ?");
  return {
    save(runId, proposal) {
      requireRun(db, runId);
      if (!getSeries.get(proposal.triggerSeriesId)) throw new Error(`FollowUpProposal ${proposal.id} references missing TrendSeries`);
      const event = parse<TrendEvent>(getEvent.get(proposal.triggerEventId) as { payload_json: string } | undefined);
      if (!event || event.seriesId !== proposal.triggerSeriesId || !["spike", "sustained_growth", "momentum_up"].includes(event.kind)) {
        throw new Error(`FollowUpProposal ${proposal.id} references an invalid trigger event`);
      }
      const expected = proposeFollowUpHuntingTask({
        triggerEventId: proposal.triggerEventId, triggerSeriesId: proposal.triggerSeriesId,
        triggerKind: event.kind as "spike" | "sustained_growth" | "momentum_up", subject: proposal.subject,
      });
      if (expected.id !== proposal.id || expected.subject !== proposal.subject ||
        JSON.stringify(expected.requiredLanes) !== JSON.stringify(proposal.requiredLanes) ||
        JSON.stringify(expected.suggestedLenses) !== JSON.stringify(proposal.suggestedLenses)) {
        throw new Error(`FollowUpProposal ${proposal.id} conflicts with canonical Core proposal`);
      }
      const existing = parse<FollowUpHuntingTaskProposal>(get.get(runId, proposal.id) as { payload_json: string } | undefined);
      if (existing?.status === "created" && JSON.stringify(existing) !== JSON.stringify(proposal)) throw new Error(`FollowUpProposal ${runId}/${proposal.id} is already created`);
      if (proposal.status === "created") {
        if (!proposal.createdBriefId || !proposal.createdAt) throw new Error(`FollowUpProposal ${proposal.id} created transition requires Brief and timestamp`);
        if (!existing || existing.status !== "proposed") throw new Error(`FollowUpProposal ${proposal.id} must transition from persisted proposed state`);
        const brief = parse<{ id: string; createdAt: string; origin?: { kind: string; parentRunId: string; trendEventId: string; trendSeriesId: string } }>(getBrief.get(proposal.createdBriefId) as { payload_json: string } | undefined);
        if (!brief || brief.id !== proposal.createdBriefId || brief.createdAt !== proposal.createdAt ||
          brief.origin?.kind !== "trend_anomaly" || brief.origin.parentRunId !== runId ||
          brief.origin.trendEventId !== proposal.triggerEventId || brief.origin.trendSeriesId !== proposal.triggerSeriesId) {
          throw new Error(`FollowUpProposal ${proposal.id} created Brief has invalid trend origin`);
        }
      }
      if (proposal.status === "proposed" && (proposal.createdBriefId || proposal.createdAt)) throw new Error(`FollowUpProposal ${proposal.id} proposed state cannot reference a Brief`);
      insert.run(runId, proposal.id, proposal.triggerSeriesId, proposal.triggerEventId, JSON.stringify(proposal));
      assertSame(parse(get.get(runId, proposal.id) as { payload_json: string } | undefined), proposal, `FollowUpProposal ${runId}/${proposal.id}`);
    },
    get(runId, id) { return parse(get.get(runId, id) as { payload_json: string } | undefined); },
    listByRun(runId) { return (list.all(runId) as Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as FollowUpHuntingTaskProposal); },
  };
}
