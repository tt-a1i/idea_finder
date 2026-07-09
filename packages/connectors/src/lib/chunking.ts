import type { Chunk, RawDocument } from "@idea-finder/core";

import { chunkId } from "./ids.js";

export interface ChunkingOptions {
  readonly maxChunkSize?: number;
}

const DEFAULT_MAX_CHUNK_SIZE = 2000;

/** Split document body into overlapping-free chunks with span offsets into rawBody. */
export function chunkDocument(document: RawDocument, options: ChunkingOptions = {}): Chunk[] {
  const maxSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const text = document.rawBody.trim();
  if (!text) {
    return [];
  }

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const segments: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxSize) {
      segments.push(paragraph);
      continue;
    }
    let offset = 0;
    while (offset < paragraph.length) {
      segments.push(paragraph.slice(offset, offset + maxSize));
      offset += maxSize;
    }
  }

  const chunks: Chunk[] = [];
  let cursor = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const spanStart = text.indexOf(segment, cursor);
    const start = spanStart >= 0 ? spanStart : cursor;
    const spanEnd = start + segment.length;
    cursor = spanEnd;
    chunks.push({
      id: chunkId(document.id, i),
      documentId: document.id,
      text: segment,
      spanStart: start,
      spanEnd,
    });
  }

  return chunks;
}
