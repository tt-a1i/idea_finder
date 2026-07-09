import type { Chunk, RawDocument, RawSignal, SignalType } from "@idea-finder/core";

import { quoteHash, signalId } from "./ids.js";

export interface SignalRule {
  readonly signalType: SignalType;
  readonly subtype: string;
  readonly patterns: readonly RegExp[];
  readonly baseConfidence: number;
}

export const SIGNAL_RULES_V1: readonly SignalRule[] = [
  {
    signalType: "pain",
    subtype: "keyword_pain",
    patterns: [/\b(painful|frustrat\w*|annoy\w*|hate|sucks|terrible|broken|buggy)\b/gi],
    baseConfidence: 0.75,
  },
  {
    signalType: "workaround",
    subtype: "keyword_workaround",
    patterns: [
      /\b(workaround|manually|spreadsheet|google sheets?|excel|hacky|duct tape|jury.?rig)\b/gi,
    ],
    baseConfidence: 0.72,
  },
  {
    signalType: "alternative_seek",
    subtype: "keyword_alternative",
    patterns: [
      /\b(alternative|is there (a|an) (tool|app)|any (tool|app) for|looking for (a|an)|recommendations?\s+for)\b/gi,
    ],
    baseConfidence: 0.7,
  },
  {
    signalType: "willingness_to_pay",
    subtype: "keyword_wtp",
    patterns: [
      /\b(would pay|pay for|worth paying|subscription|happy to pay|take my money)\b/gi,
    ],
    baseConfidence: 0.78,
  },
  {
    signalType: "competitor_dissatisfaction",
    subtype: "keyword_competitor",
    patterns: [
      /\b(too expensive|price hike|worse than|disappointed (with|in)|switched from|cancelled)\b/gi,
    ],
    baseConfidence: 0.74,
  },
  {
    signalType: "feature_request",
    subtype: "keyword_feature",
    patterns: [
      /\b(feature request|wish (it|they) (had|would)|missing feature|need a way to|please add)\b/gi,
    ],
    baseConfidence: 0.71,
  },
  {
    signalType: "validation_negative",
    subtype: "keyword_validation_negative",
    patterns: [
      /\b(works fine|already solved|don't need|not a problem|no need for|overkill)\b/gi,
    ],
    baseConfidence: 0.73,
  },
  {
    signalType: "noise",
    subtype: "keyword_noise",
    patterns: [/\b(lol|lmao|click here|buy now|free money|nft|crypto pump)\b/gi],
    baseConfidence: 0.6,
  },
] as const;

const DETECTOR_VERSION = "rule_v1.0.0";

export interface DetectSignalsOptions {
  readonly rules?: readonly SignalRule[];
  readonly extractedAt?: string;
}

function expandQuote(text: string, matchStart: number, matchEnd: number): { start: number; end: number } {
  let start = matchStart;
  let end = matchEnd;

  while (start > 0 && !/[.!?\n]/.test(text[start - 1]!)) {
    start--;
    if (matchStart - start > 80) break;
  }
  while (end < text.length && !/[.!?\n]/.test(text[end]!)) {
    end++;
    if (end - matchEnd > 80) break;
  }

  return { start, end };
}

/** Deterministic keyword/span signal extraction — no LLM. */
export function detectSignalsInChunk(
  chunk: Chunk,
  document: RawDocument,
  options: DetectSignalsOptions = {},
): RawSignal[] {
  const rules = options.rules ?? SIGNAL_RULES_V1;
  const extractedAt = options.extractedAt ?? new Date().toISOString();
  const signals: RawSignal[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(chunk.text)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;
        const { start, end } = expandQuote(chunk.text, matchStart, matchEnd);
        const quoteVerbatim = chunk.text.slice(start, end);
        const dedupeKey = `${rule.signalType}:${start}:${end}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const spanStart = chunk.spanStart + start;
        const spanEnd = chunk.spanStart + end;

        signals.push({
          id: signalId(chunk.id, rule.signalType, spanStart),
          chunkId: chunk.id,
          documentId: document.id,
          signalType: rule.signalType,
          signalSubtype: rule.subtype,
          quoteVerbatim,
          quoteHash: quoteHash(quoteVerbatim),
          spanStart,
          spanEnd,
          confidenceRule: rule.baseConfidence,
          detector: "rule_v1",
          detectorVersion: DETECTOR_VERSION,
          extractedAt,
        });
      }
    }
  }

  return signals;
}

export function detectSignals(
  chunks: readonly Chunk[],
  document: RawDocument,
  options?: DetectSignalsOptions,
): RawSignal[] {
  return chunks.flatMap((chunk) => detectSignalsInChunk(chunk, document, options));
}
