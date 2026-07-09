import { createHash } from "node:crypto";

import { asId, type ChunkId, type RawDocumentId, type RawSignalId } from "@idea-finder/core";

export function documentId(platform: string, key: string): RawDocumentId {
  const hash = createHash("sha256").update(`${platform}:${key}`).digest("hex").slice(0, 16);
  return asId(`doc_${hash}`);
}

export function chunkId(documentId: RawDocumentId, index: number): ChunkId {
  return asId(`chk_${documentId}_${index}`);
}

export function signalId(chunkId: ChunkId, signalType: string, spanStart: number): RawSignalId {
  const hash = createHash("sha256")
    .update(`${chunkId}:${signalType}:${spanStart}`)
    .digest("hex")
    .slice(0, 12);
  return asId(`sig_${hash}`);
}

export function quoteHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
