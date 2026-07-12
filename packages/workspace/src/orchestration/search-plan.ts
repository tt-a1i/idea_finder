import { randomUUID } from "node:crypto";
import type { ResearchLens, SearchPlan } from "../types.js";

const DEFAULT_LENSES: readonly ResearchLens[] = [
  "topic_synonym",
  "persona",
  "scenario",
  "pain_failure",
  "workaround",
  "alternative_seeking",
  "commercial_intent",
  "competitor_dissatisfaction",
  "contradiction",
];

const DEFAULT_SOURCES = ["hn", "v2ex", "stack_exchange", "github_issues"] as const;

function defaultTimeWindow(now = new Date()): { from: string; to: string } {
  const to = now.toISOString();
  const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

export function buildProposedSearchPlan(input: {
  readonly topic: string;
  readonly personas?: readonly string[];
  readonly scenarios?: readonly string[];
  readonly languages?: readonly string[];
  readonly geography?: string;
  readonly timeWindow?: { readonly from: string; readonly to: string };
  readonly sourceFamilies?: readonly string[];
  readonly researchLenses?: readonly ResearchLens[];
  readonly budgets?: { readonly queries?: number; readonly documents?: number; readonly rounds?: number };
  readonly now?: Date;
}): SearchPlan {
  const topic = input.topic.trim();
  if (!topic) throw new Error("Search plan topic is required");
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: `plan_${randomUUID()}`,
    version: 1,
    status: "proposed",
    topic,
    personas: input.personas?.length ? [...input.personas] : ["practitioners affected by the topic"],
    scenarios: input.scenarios?.length ? [...input.scenarios] : ["day-to-day workflow involving the topic"],
    languages: input.languages?.length ? [...input.languages] : ["en", "zh"],
    geography: input.geography?.trim() || "WORLDWIDE",
    timeWindow: input.timeWindow ?? defaultTimeWindow(input.now),
    sourceFamilies: input.sourceFamilies?.length ? [...input.sourceFamilies] : [...DEFAULT_SOURCES],
    researchLenses: input.researchLenses?.length ? [...input.researchLenses] : [...DEFAULT_LENSES],
    budgets: {
      queries: input.budgets?.queries ?? 60,
      documents: input.budgets?.documents ?? 200,
      rounds: input.budgets?.rounds ?? 3,
    },
    confirmation: {
      mode: "explicit",
      confirmedAt: null,
      defaultsApplied: true,
    },
    queries: [],
    briefId: null,
    briefSlug: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function confirmSearchPlanEntity(
  plan: SearchPlan,
  options: {
    readonly mode?: "explicit" | "start_now";
    readonly briefId?: string;
    readonly briefSlug?: string;
    readonly now?: Date;
  } = {},
): SearchPlan {
  if (plan.status === "confirmed") return plan;
  const now = (options.now ?? new Date()).toISOString();
  return {
    ...plan,
    status: "confirmed",
    confirmation: {
      mode: options.mode ?? "explicit",
      confirmedAt: now,
      defaultsApplied: plan.confirmation.defaultsApplied,
    },
    briefId: options.briefId ?? plan.briefId ?? null,
    briefSlug: options.briefSlug ?? plan.briefSlug ?? null,
    updatedAt: now,
  };
}

export function slugFromTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `topic-${randomUUID().slice(0, 8)}`;
}
