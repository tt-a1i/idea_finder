import { createHash, randomUUID } from "node:crypto";
import type { ResearchLens, SearchPlan, SearchQueryVariant } from "../types.js";

const LENS_TEMPLATES: ReadonlyArray<{
  lens: ResearchLens;
  en: readonly string[];
  zh: readonly string[];
}> = [
  { lens: "topic_synonym", en: ["", "tool", "workflow", "software"], zh: ["", "工具", "工作流", "软件"] },
  { lens: "persona", en: ["for developers", "for founders", "for PMs", "for ops"], zh: ["开发者", "创业者", "产品经理", "运维"] },
  { lens: "scenario", en: ["daily workflow", "onboarding", "incident response", "reporting"], zh: ["日常工作流", "上手流程", "故障排查", "汇报"] },
  { lens: "pain_failure", en: ["painful", "frustrating", "broken", "fails"], zh: ["痛点", "很麻烦", "不好用", "总是失败"] },
  { lens: "workaround", en: ["workaround", "manually", "spreadsheet", "hack"], zh: ["变通办法", "手动处理", "用表格", "临时方案"] },
  { lens: "alternative_seeking", en: ["alternative to", "looking for tool", "replace", "recommendations"], zh: ["替代方案", "有没有工具", "想换掉", "求推荐"] },
  { lens: "commercial_intent", en: ["would pay", "pricing", "subscription", "worth paying"], zh: ["愿意付费", "价格", "订阅", "值不值得买"] },
  { lens: "competitor_dissatisfaction", en: ["too expensive", "switched from", "cancelled", "disappointed"], zh: ["太贵了", "从…换过来", "取消订阅", "失望"] },
  { lens: "contradiction", en: ["already solved", "works fine", "no need", "overkill"], zh: ["已经够用", "没什么问题", "不需要", "杀鸡用牛刀"] },
];

function dedupeKey(text: string, source: string, language: string): string {
  return createHash("sha256").update(`${language}|${source}|${text.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

function queryTextFor(topic: string, lens: ResearchLens, suffix: string, language: string): string {
  if (!suffix) return topic;
  if (lens === "alternative_seeking" || lens === "competitor_dissatisfaction") {
    return language === "zh" ? `${suffix} ${topic}` : `${suffix} ${topic}`;
  }
  return `${topic} ${suffix}`;
}

function suffixesFor(template: (typeof LENS_TEMPLATES)[number], language: string): readonly string[] {
  return language === "zh" ? template.zh : template.en;
}

/** Build ≥30 deduped broad query variants with rotated language/source/lens coverage. */
export function buildBroadQueryVariants(plan: SearchPlan, options: { readonly round?: number } = {}): SearchQueryVariant[] {
  const round = options.round ?? 1;
  const sources = plan.sourceFamilies.filter((source) =>
    ["hn", "v2ex", "stack_exchange", "app_store", "github_issues"].includes(source),
  );
  const effectiveSources = sources.length > 0 ? sources : ["hn", "stack_exchange"];
  const languages = plan.languages.length > 0 ? plan.languages : ["en"];
  const maxQueries = Math.max(plan.budgets.queries, 30);
  const seen = new Set<string>();
  const variants: SearchQueryVariant[] = [];

  const push = (text: string, lens: ResearchLens, source: string, language: string) => {
    const queryText = text.trim().replace(/\s+/g, " ");
    if (!queryText) return false;
    const key = dedupeKey(queryText, source, language);
    if (seen.has(key)) return false;
    seen.add(key);
    variants.push({
      id: `q_${randomUUID().slice(0, 12)}`,
      queryText,
      language,
      source,
      lens,
      round,
      parentQueryId: null,
      triggerEvidenceId: null,
      status: "pending",
      itemCount: 0,
      error: null,
    });
    return true;
  };

  type Slot = { language: string; source: string; lens: ResearchLens; text: string };
  const slots: Slot[] = [];
  const maxSuffixLen = Math.max(...LENS_TEMPLATES.map((item) => Math.max(item.en.length, item.zh.length)));
  for (let suffixIndex = 0; suffixIndex < maxSuffixLen; suffixIndex += 1) {
    for (const template of LENS_TEMPLATES) {
      for (const language of languages) {
        const suffixes = suffixesFor(template, language);
        const suffix = suffixes[suffixIndex];
        if (suffix === undefined) continue;
        for (const source of effectiveSources) {
          slots.push({
            language,
            source,
            lens: template.lens,
            text: queryTextFor(plan.topic, template.lens, suffix, language),
          });
        }
      }
    }
  }
  for (const persona of plan.personas) {
    for (const language of languages) {
      for (const source of effectiveSources) {
        slots.push({ language, source, lens: "persona", text: `${plan.topic} ${persona}` });
      }
    }
  }
  for (const scenario of plan.scenarios) {
    for (const language of languages) {
      for (const source of effectiveSources) {
        slots.push({ language, source, lens: "scenario", text: `${plan.topic} ${scenario}` });
      }
    }
  }

  for (const slot of slots) {
    push(slot.text, slot.lens, slot.source, slot.language);
    if (variants.length >= maxQueries) break;
  }

  while (variants.length < 30) {
    const lens = LENS_TEMPLATES[variants.length % LENS_TEMPLATES.length]!;
    const source = effectiveSources[variants.length % effectiveSources.length]!;
    const language = languages[variants.length % languages.length]!;
    const suffixes = suffixesFor(lens, language);
    push(
      `${plan.topic} ${suffixes[variants.length % suffixes.length] ?? (language === "zh" ? "需求" : "demand")} #${variants.length}`,
      lens.lens,
      source,
      language,
    );
    if (variants.length > 200) break;
  }

  return variants.slice(0, maxQueries);
}

export function countDistinctLenses(queries: readonly SearchQueryVariant[]): number {
  return new Set(queries.map((query) => query.lens)).size;
}

export function coverageStats(queries: readonly SearchQueryVariant[]): {
  readonly languages: number;
  readonly sources: number;
  readonly lenses: number;
} {
  return {
    languages: new Set(queries.map((query) => query.language)).size,
    sources: new Set(queries.map((query) => query.source)).size,
    lenses: countDistinctLenses(queries),
  };
}
