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

export const SIGNAL_RULES_ZH_V1: readonly SignalRule[] = [
  {
    signalType: "pain",
    subtype: "keyword_pain_zh",
    patterns: [/(太难用|不好用|很痛苦|崩溃|折腾|头疼|烦死了|坑|难受|失败)/g],
    baseConfidence: 0.75,
  },
  {
    signalType: "workaround",
    subtype: "keyword_workaround_zh",
    patterns: [/(手动|手工|自己写|用表格|用Excel|临时方案|绕过|凑合)/g],
    baseConfidence: 0.72,
  },
  {
    signalType: "alternative_seek",
    subtype: "keyword_alternative_zh",
    patterns: [/(有没有别的|求推荐|替代方案|换一个工具|有什么更好的)/g],
    baseConfidence: 0.7,
  },
  {
    signalType: "willingness_to_pay",
    subtype: "keyword_wtp_zh",
    patterns: [/(愿意付费|可以付钱|买会员|开通会员|值得付)/g],
    baseConfidence: 0.78,
  },
  {
    signalType: "competitor_dissatisfaction",
    subtype: "keyword_competitor_zh",
    patterns: [/(太贵了|涨价|取消订阅|退订|从.+换到|失望)/g],
    baseConfidence: 0.74,
  },
  {
    signalType: "feature_request",
    subtype: "keyword_feature_zh",
    patterns: [/(希望能|求功能|缺少|能不能加|建议增加)/g],
    baseConfidence: 0.71,
  },
  {
    signalType: "validation_negative",
    subtype: "keyword_validation_negative_zh",
    patterns: [/(已经解决|不需要|没问题|够用了|杀鸡用牛刀|免费就有)/g],
    baseConfidence: 0.73,
  },
] as const;

export const SIGNAL_RULES_ALL_V1: readonly SignalRule[] = [...SIGNAL_RULES_V1, ...SIGNAL_RULES_ZH_V1];

const DETECTOR_VERSION = "rule_v1.1.0";

const NEGATION_GUARD_EN = /\b(not|n't|never|no longer|hardly|without)\b/i;
const NEGATION_GUARD_ZH = /(并不|并没有|没有必要|不再|无需|不需要|谈不上|未必)/;
const ATTRIBUTION_GUARD_EN = /\b(they said|someone said|people say|according to|quoted)\b/i;
const ATTRIBUTION_GUARD_ZH = /(他说|她说|有人说|别人说|据称|转述)/;

function isNegatedContext(text: string, matchStart: number): boolean {
  const window = text.slice(Math.max(0, matchStart - 16), matchStart);
  return NEGATION_GUARD_EN.test(window) || NEGATION_GUARD_ZH.test(window);
}

function isAttributedQuote(text: string, matchStart: number): boolean {
  const window = text.slice(Math.max(0, matchStart - 24), matchStart + 24);
  return ATTRIBUTION_GUARD_EN.test(window) || ATTRIBUTION_GUARD_ZH.test(window);
}

export interface DetectSignalsOptions {
  readonly rules?: readonly SignalRule[];
  readonly extractedAt?: string;
}

function expandQuote(text: string, matchStart: number, matchEnd: number): { start: number; end: number } {
  let start = matchStart;
  let end = matchEnd;

  while (start > 0 && !/[.!?\n。！？]/.test(text[start - 1]!)) {
    start--;
    if (matchStart - start > 80) break;
  }
  while (end < text.length && !/[.!?\n。！？]/.test(text[end]!)) {
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
  const rules = options.rules ?? SIGNAL_RULES_ALL_V1;
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
        if (isNegatedContext(chunk.text, matchStart)) continue;
        if (isAttributedQuote(chunk.text, matchStart)) continue;
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
