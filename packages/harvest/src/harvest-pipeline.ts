import {
  chunkDocument,
  connectorByPlatform,
  createManualImportConnector,
  detectSignals,
  type ManualImportConnector,
  type QueryPlan,
  type SourceConnector,
} from "@idea-finder/connectors";
import type { Chunk, RawDocument, RawSignal, ResearchRunId } from "@idea-finder/core";

import type { HarvestRepository, HarvestResult, SourceExecutionResult } from "./ports/harvest-repository.js";

export interface HarvestPipelineDeps {
  readonly connectors: readonly SourceConnector[];
  readonly repository?: HarvestRepository;
}

export interface HarvestPipeline {
  /**
   * Runs harvest for a research run: connectors → normalize → chunk → rule signals.
   * Resolves with normalized output ready for the intelligence stage.
   */
  runHarvest(runId: ResearchRunId, plan: QueryPlan, options?: { readonly completedRequestKeys?: ReadonlySet<string> }): Promise<HarvestResult>;
}

export function createHarvestPipeline(deps: HarvestPipelineDeps): HarvestPipeline {
  const manualConnector =
    (connectorByPlatform(deps.connectors, "manual") as ManualImportConnector | undefined) ??
    createManualImportConnector();

  return {
    async runHarvest(runId: ResearchRunId, plan: QueryPlan, options = {}): Promise<HarvestResult> {
      const documents: RawDocument[] = [];
      const chunks: Chunk[] = [];
      const signals: RawSignal[] = [];
      const seenDocKeys = new Set<string>();
      const sourceExecutions: SourceExecutionResult[] = [];

      for (const [index, search] of plan.searches.entries()) {
        const requestKey = search.queryId ? `query:${search.queryId}` : `search:${index}:${search.platform}`;
        if (options.completedRequestKeys?.has(requestKey)) continue;
        const startedAt = new Date().toISOString();
        const connector = connectorByPlatform(deps.connectors, search.platform);
        if (!connector) {
          const status = execution(requestKey, search.platform, "skipped", 0, "connector_missing", `No connector registered for platform: ${search.platform}`, startedAt);
          if (deps.repository) await deps.repository.saveSourceResult(runId, { documents: [], chunks: [], signals: [] }, status);
          sourceExecutions.push(status);
          continue;
        }
        const sourceDocuments: RawDocument[] = [];
        const sourceChunks: Chunk[] = [];
        const sourceSignals: RawSignal[] = [];
        let status: SourceExecutionResult;
        try {
          const query = { ...search, huntingTaskId: plan.huntingTaskId };
          for await (const doc of connector.search(query)) {
            const key = `${doc.platform}:${doc.externalId ?? doc.url}`;
            if (seenDocKeys.has(key)) continue;
            seenDocKeys.add(key);
            ingestDocument(doc, sourceChunks, sourceSignals);
            sourceDocuments.push(doc);
          }
          status = execution(requestKey, search.platform, "success", sourceDocuments.length, sourceDocuments.length === 0 ? "zero_results" : "none", null, startedAt);
        } catch (error) {
          status = classifyExecution(requestKey, search.platform, error, startedAt);
        }
        const persisted = status.status === "success" ? { documents: sourceDocuments, chunks: sourceChunks, signals: sourceSignals } : { documents: [], chunks: [], signals: [] };
        if (deps.repository) await deps.repository.saveSourceResult(runId, persisted, status);
        if (status.status === "success") { documents.push(...sourceDocuments); chunks.push(...sourceChunks); signals.push(...sourceSignals); }
        sourceExecutions.push(status);
      }

      const manualRequestKey = "manual:imports";
      const manualStartedAt = new Date().toISOString();
      const manualDocuments: RawDocument[] = [];
      const manualChunks: Chunk[] = [];
      const manualSignals: RawSignal[] = [];
      for (const input of options.completedRequestKeys?.has(manualRequestKey) ? [] : plan.manualImports ?? []) {
        const doc = manualConnector.importText(input, plan.huntingTaskId);
        const key = `${doc.platform}:${doc.externalId ?? doc.url}`;
        if (seenDocKeys.has(key)) continue;
        seenDocKeys.add(key);
        ingestDocument(doc, manualChunks, manualSignals);
        manualDocuments.push(doc);
      }
      if (!options.completedRequestKeys?.has(manualRequestKey) && (plan.manualImports?.length ?? 0) > 0) {
        const status = execution(manualRequestKey, "manual", "success", manualDocuments.length, manualDocuments.length === 0 ? "zero_results" : "none", null, manualStartedAt);
        if (deps.repository) await deps.repository.saveSourceResult(runId, { documents: manualDocuments, chunks: manualChunks, signals: manualSignals }, status);
        documents.push(...manualDocuments); chunks.push(...manualChunks); signals.push(...manualSignals);
        sourceExecutions.push(status);
      }

      const result: HarvestResult = { documents, chunks, signals, sourceExecutions };
      if (deps.repository) await deps.repository.saveResult(runId, result);
      return result;
    },
  };
}

function execution(requestKey: string, source: string, status: SourceExecutionResult["status"], itemCount: number, reasonCode: SourceExecutionResult["reasonCode"], reason: string | null, startedAt: string): SourceExecutionResult {
  return { id: requestKey, source, requestKey, status, itemCount, reasonCode, reason, startedAt, completedAt: new Date().toISOString(), retryAt: null };
}

function classifyExecution(requestKey: string, source: string, error: unknown, startedAt: string): SourceExecutionResult {
  const reason = error instanceof Error ? error.message : String(error);
  const lower = reason.toLowerCase();
  if (/unauthor|forbidden|401|credential|token required/.test(lower)) return execution(requestKey, source, "unauthorized", 0, "unauthorized", reason, startedAt);
  if (/thrott|rate.?limit|429|retry-after/.test(lower)) {
    const retryAt = typeof error === "object" && error !== null
      ? ((error as { retryAt?: unknown; resetAt?: unknown }).retryAt ?? (error as { resetAt?: unknown }).resetAt)
      : null;
    return { ...execution(requestKey, source, "throttled", 0, "throttled", reason, startedAt), retryAt: typeof retryAt === "string" ? retryAt : null };
  }
  if (/unavailable|timeout|network|fetch failed|http 5\d\d/.test(lower)) return execution(requestKey, source, "unavailable", 0, "unavailable", reason, startedAt);
  return execution(requestKey, source, "failure", 0, "failed", reason, startedAt);
}

function ingestDocument(doc: RawDocument, chunks: Chunk[], signals: RawSignal[]): void {
  const docChunks = chunkDocument(doc);
  chunks.push(...docChunks);
  signals.push(...detectSignals(docChunks, doc));
}
