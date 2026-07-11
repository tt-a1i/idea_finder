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
