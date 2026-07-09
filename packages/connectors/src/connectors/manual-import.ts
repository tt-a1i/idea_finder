import { createHash } from "node:crypto";

import type { HuntingTaskId, RawDocument } from "@idea-finder/core";

import { normalizeDocument } from "../lib/normalize.js";
import type { ManualImportInput } from "../query-plan.js";
import type { ConnectorHealth, SourceConnector } from "../ports/source-connector.js";

export interface ManualImportConnector extends SourceConnector {
  importText(input: ManualImportInput, huntingTaskId: HuntingTaskId): RawDocument;
}

export function createManualImportConnector(): ManualImportConnector {
  return {
    platform: "manual",

    async healthcheck(): Promise<ConnectorHealth> {
      return { ok: true, message: "local import; no remote healthcheck" };
    },

    async *search(): AsyncIterable<RawDocument> {
      // Manual import is driven via QueryPlan.manualImports, not search terms.
    },

    async fetch(externalId: string): Promise<RawDocument> {
      throw new Error(`Manual import does not support fetch by id: ${externalId}`);
    },

    importText(input: ManualImportInput, huntingTaskId: HuntingTaskId): RawDocument {
      const url = input.url ?? `manual://import/${contentHash(input.text)}`;
      const title = input.title ? `${input.title}\n\n` : "";
      const rawBody = `${title}${input.text}`.trim();
      const externalId = contentHash(rawBody);

      return normalizeDocument({
        platform: "manual",
        externalId,
        url,
        rawBody,
        contentType: "page",
        huntingTaskId,
        fetchMethod: "import",
        legalBasis: "user_provided",
        retentionClass: "pinned",
      });
    },
  };
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
