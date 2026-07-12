import { createHash } from "node:crypto";

import {
  createUnavailableGoogleTrendsTransport,
  GoogleTrendsSourceError,
  type GoogleTrendsTransport,
  type GoogleTrendsTransportProvenance,
  type GoogleTrendsTransportQuery,
} from "../ports/google-trends-transport.js";

export interface GoogleTrendsCollectionRequest extends GoogleTrendsTransportQuery {}

export interface GoogleTrendsNormalizationContext {
  readonly scale: "relative_0_100";
  readonly subject: string;
  readonly geography: string;
  readonly from: string;
  readonly to: string;
  readonly granularity: "day" | "week";
  readonly comparisonSet: readonly string[];
  readonly anchor: string | null;
  readonly category: string;
  readonly property: "web" | "news" | "images" | "youtube" | "shopping";
  readonly containsPartialData: boolean;
}

export interface CollectedGoogleTrendsObservation {
  readonly id: string;
  readonly source: "google_trends";
  readonly metric: "search_interest";
  readonly subject: string;
  readonly geography: string;
  readonly observedAt: string;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly unit: "relative_interest";
  readonly partial: boolean;
  readonly collectionMethod: "authorized_transport";
  readonly normalizationContext: GoogleTrendsNormalizationContext;
  readonly provenance: GoogleTrendsTransportProvenance;
}

export interface GoogleTrendsCollectionResult {
  readonly observations: readonly CollectedGoogleTrendsObservation[];
  readonly normalizationContext: GoogleTrendsNormalizationContext;
  readonly provenance: GoogleTrendsTransportProvenance;
}

export interface GoogleTrendsConnectorOptions {
  readonly transport?: GoogleTrendsTransport;
}

interface ParsedRow {
  readonly time: string;
  readonly value: number;
  readonly partial: boolean;
}

function validateRequest(request: GoogleTrendsCollectionRequest): GoogleTrendsCollectionRequest {
  const subject = request.subject.trim();
  if (!subject) throw new Error("Google Trends subject must not be empty");
  const geography = request.geography.toUpperCase();
  if (!/^(?:[A-Z]{2}|WORLDWIDE)$/.test(geography)) {
    throw new Error("Google Trends geography must be an ISO-3166 alpha-2 code or WORLDWIDE");
  }
  const fromMs = Date.parse(request.from);
  const toMs = Date.parse(request.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new Error("Google Trends from/to must be ISO date-times");
  if (fromMs >= toMs) throw new Error("Google Trends from must be earlier than to");
  if (request.granularity !== "day" && request.granularity !== "week") {
    throw new Error("Google Trends granularity must be day or week");
  }
  const category = request.category.trim();
  if (!category) throw new Error("Google Trends category must not be empty");
  if (!["web", "news", "images", "youtube", "shopping"].includes(request.property)) {
    throw new Error("Google Trends property is invalid");
  }
  return { subject, geography, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), granularity: request.granularity, category, property: request.property };
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new GoogleTrendsSourceError("response_drift", `${path} must be an array of non-empty strings`);
  }
  return [...value];
}

function parsePayload(payload: unknown): { rows: ParsedRow[]; comparisonSet: string[]; anchor: string | null } {
  if (!payload || typeof payload !== "object") {
    throw new GoogleTrendsSourceError("response_drift", "Google Trends payload must be an object");
  }
  const value = payload as Record<string, unknown>;
  if (!Array.isArray(value.rows)) throw new GoogleTrendsSourceError("response_drift", "Google Trends rows must be an array");
  const comparisonSet = stringArray(value.comparisonSet, "Google Trends comparisonSet");
  if (value.anchor !== null && typeof value.anchor !== "string") {
    throw new GoogleTrendsSourceError("response_drift", "Google Trends anchor must be a string or null");
  }
  const unique = new Map<string, ParsedRow>();
  for (const item of value.rows) {
    if (!item || typeof item !== "object") throw new GoogleTrendsSourceError("response_drift", "Google Trends row must be an object");
    const row = item as Record<string, unknown>;
    if (typeof row.time !== "string" || Number.isNaN(Date.parse(row.time))) {
      throw new GoogleTrendsSourceError("response_drift", "Google Trends row.time must be an ISO date-time");
    }
    if (typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0 || row.value > 100) {
      throw new GoogleTrendsSourceError("response_drift", "Google Trends row.value must be between 0 and 100");
    }
    if (row.partial !== undefined && typeof row.partial !== "boolean") {
      throw new GoogleTrendsSourceError("response_drift", "Google Trends row.partial must be boolean");
    }
    const parsed = { time: new Date(row.time).toISOString(), value: row.value, partial: row.partial ?? false };
    const existing = unique.get(parsed.time);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new GoogleTrendsSourceError("response_drift", `Conflicting Google Trends rows for ${parsed.time}`);
    }
    unique.set(parsed.time, parsed);
  }
  return { rows: [...unique.values()].sort((a, b) => a.time.localeCompare(b.time)), comparisonSet, anchor: value.anchor as string | null };
}

function validateProvenance(provenance: GoogleTrendsTransportProvenance): void {
  if (!provenance || !["authorized_api", "public_dataset", "recorded_fixture"].includes(provenance.authorizedInterface)) {
    throw new GoogleTrendsSourceError("response_drift", "Google Trends authorizedInterface is invalid");
  }
  if (![provenance.transport, provenance.transportVersion, provenance.sourceRef].every((item) => typeof item === "string" && item.trim() !== "")) {
    throw new GoogleTrendsSourceError("response_drift", "Google Trends transport provenance is incomplete");
  }
  if (typeof provenance.retrievedAt !== "string" || Number.isNaN(Date.parse(provenance.retrievedAt))) {
    throw new GoogleTrendsSourceError("response_drift", "Google Trends provenance.retrievedAt must be an ISO date-time");
  }
}

function observationId(request: GoogleTrendsCollectionRequest, observedAt: string): string {
  return `metric_${createHash("sha256").update([
    "google_trends", request.subject, request.geography, request.from, request.to, request.granularity, observedAt,
  ].join("\0")).digest("hex").slice(0, 24)}`;
}

export function createGoogleTrendsConnector(options: GoogleTrendsConnectorOptions = {}) {
  const transport = options.transport ?? createUnavailableGoogleTrendsTransport();
  return {
    source: "google_trends" as const,
    async collect(input: GoogleTrendsCollectionRequest): Promise<GoogleTrendsCollectionResult> {
      const request = validateRequest(input);
      const response = await transport.query(request);
      validateProvenance(response.provenance);
      const parsed = parsePayload(response.payload);
      if (parsed.rows.length === 0) {
        throw new GoogleTrendsSourceError("unavailable", "Google Trends returned no data for the requested subject, geography, and time window");
      }
      const fromMs = Date.parse(request.from);
      const toMs = Date.parse(request.to);
      if (parsed.rows.some((row) => Date.parse(row.time) < fromMs || Date.parse(row.time) > toMs)) {
        throw new GoogleTrendsSourceError("response_drift", "Google Trends row falls outside the requested time window");
      }
      const canonicalComparisonSet = [...new Set(parsed.comparisonSet.map((item) => item.trim()))].sort();
      if (canonicalComparisonSet.length !== parsed.comparisonSet.length
        || canonicalComparisonSet.some((item, index) => item !== parsed.comparisonSet[index])) {
        throw new GoogleTrendsSourceError("response_drift", "Google Trends comparisonSet must be unique, trimmed, and sorted");
      }
      if (!canonicalComparisonSet.includes(request.subject)) {
        throw new GoogleTrendsSourceError("response_drift", "Google Trends comparisonSet must contain the requested subject");
      }
      const context: GoogleTrendsNormalizationContext = {
        scale: "relative_0_100", subject: request.subject, geography: request.geography,
        from: request.from, to: request.to, granularity: request.granularity,
        comparisonSet: canonicalComparisonSet, anchor: parsed.anchor, category: request.category, property: request.property,
        containsPartialData: parsed.rows.some((row) => row.partial),
      };
      return {
        normalizationContext: context,
        provenance: response.provenance,
        observations: parsed.rows.map((row) => ({
          id: observationId(request, row.time), source: "google_trends", metric: "search_interest",
          subject: request.subject, geography: request.geography, observedAt: row.time,
          rawValue: row.value, normalizedValue: row.value, unit: "relative_interest", partial: row.partial,
          collectionMethod: "authorized_transport", normalizationContext: context, provenance: response.provenance,
        })),
      };
    },
  };
}
