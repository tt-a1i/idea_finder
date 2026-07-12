export type GoogleTrendsSourceStatus =
  | "authorization_required"
  | "throttled"
  | "unavailable"
  | "response_drift";

export class GoogleTrendsSourceError extends Error {
  constructor(
    readonly status: GoogleTrendsSourceStatus,
    message: string,
    readonly retryAt: string | null = null,
  ) {
    super(message);
    this.name = "GoogleTrendsSourceError";
  }
}

export interface GoogleTrendsTransportQuery {
  readonly subject: string;
  readonly geography: string;
  readonly from: string;
  readonly to: string;
  readonly granularity: "day" | "week";
  readonly category: string;
  readonly property: "web" | "news" | "images" | "youtube" | "shopping";
}

export interface GoogleTrendsTransportProvenance {
  readonly transport: string;
  readonly transportVersion: string;
  readonly authorizedInterface: "authorized_api" | "public_dataset" | "recorded_fixture";
  readonly sourceRef: string;
  readonly retrievedAt: string;
}

export interface GoogleTrendsTransportResponse {
  /** Provider-neutral payload returned by an explicitly authorized adapter. */
  readonly payload: unknown;
  readonly provenance: GoogleTrendsTransportProvenance;
}

/** Authorization boundary. Implementations must use an approved Google API or public dataset. */
export interface GoogleTrendsTransport {
  query(request: GoogleTrendsTransportQuery): Promise<GoogleTrendsTransportResponse>;
}

export interface AuthorizedHttpGoogleTrendsTransportOptions {
  /** HTTPS endpoint for an authorized Google Trends API or public-dataset adapter. */
  readonly endpoint: string;
  /** Optional bearer credential. Keep credentials in environment/config, never persisted provenance. */
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

interface AuthorizedAdapterResponse {
  readonly payload: unknown;
  readonly sourceRef?: unknown;
  readonly retrievedAt?: unknown;
  readonly transportVersion?: unknown;
  readonly authorizedInterface?: unknown;
}

function configuredEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new GoogleTrendsSourceError("authorization_required", "Google Trends transport URL must be an absolute URL");
  }
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new GoogleTrendsSourceError("authorization_required", "Google Trends transport must use HTTPS (HTTP is allowed only for loopback adapters)");
  }
  if (endpoint.username || endpoint.password) {
    throw new GoogleTrendsSourceError("authorization_required", "Google Trends transport credentials must not be embedded in the URL");
  }
  return endpoint;
}

function retryAt(header: string | null): string | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(Date.now() + seconds * 1_000).toISOString();
  const timestamp = Date.parse(header);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

/**
 * Provider-neutral HTTP boundary for explicitly authorized Google Trends access.
 * The adapter owns Google credentials/schema and returns `{ payload, sourceRef? }`.
 */
export function createAuthorizedHttpGoogleTrendsTransport(
  options: AuthorizedHttpGoogleTrendsTransportOptions,
): GoogleTrendsTransport {
  const endpoint = configuredEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Google Trends transport timeoutMs must be positive");
  if (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0) throw new Error("Google Trends transport maxResponseBytes must be positive");

  return {
    async query(request) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "was unavailable";
        throw new GoogleTrendsSourceError("unavailable", `Authorized Google Trends transport ${reason}`);
      }

      if (response.status === 401 || response.status === 403) {
        throw new GoogleTrendsSourceError("authorization_required", "Authorized Google Trends transport rejected its credentials");
      }
      if (response.status === 429) {
        throw new GoogleTrendsSourceError("throttled", "Authorized Google Trends transport was throttled", retryAt(response.headers.get("retry-after")));
      }
      if (!response.ok) {
        throw new GoogleTrendsSourceError(
          response.status >= 500 ? "unavailable" : "response_drift",
          `Authorized Google Trends transport returned HTTP ${response.status}`,
        );
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends transport response exceeded the size limit");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends transport response exceeded the size limit");
      }
      let value: AuthorizedAdapterResponse;
      try {
        value = JSON.parse(text) as AuthorizedAdapterResponse;
      } catch {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends transport returned invalid JSON");
      }
      if (!value || typeof value !== "object" || !("payload" in value)) {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends adapter response must contain payload");
      }
      const sourceRef = value.sourceRef === undefined ? endpoint.toString() : value.sourceRef;
      if (typeof sourceRef !== "string" || sourceRef.trim() === "") {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends adapter sourceRef must be a non-empty string");
      }
      const retrievedAt = value.retrievedAt === undefined ? new Date().toISOString() : value.retrievedAt;
      if (typeof retrievedAt !== "string" || Number.isNaN(Date.parse(retrievedAt))) {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends adapter retrievedAt must be an ISO date-time");
      }
      const transportVersion = value.transportVersion === undefined ? "1" : value.transportVersion;
      if (typeof transportVersion !== "string" || transportVersion.trim() === "") {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends adapter transportVersion must be a non-empty string");
      }
      const authorizedInterface = value.authorizedInterface ?? "authorized_api";
      if (authorizedInterface !== "authorized_api" && authorizedInterface !== "public_dataset") {
        throw new GoogleTrendsSourceError("response_drift", "Authorized Google Trends adapter interface is invalid");
      }
      return {
        payload: value.payload,
        provenance: {
          transport: "authorized-http-adapter",
          transportVersion,
          authorizedInterface,
          sourceRef,
          retrievedAt: new Date(retrievedAt).toISOString(),
        },
      };
    },
  };
}

export function createUnavailableGoogleTrendsTransport(): GoogleTrendsTransport {
  return {
    async query() {
      throw new GoogleTrendsSourceError(
        "authorization_required",
        "Google Trends collection requires an explicitly configured authorized transport",
      );
    },
  };
}
