export type PackageEcosystem = "npm" | "pypi";
export type PackageDownloadsSourceStatus = "rate_limited" | "missing_package" | "unavailable_history" | "response_drift";

export class PackageDownloadsSourceError extends Error {
  constructor(readonly status: PackageDownloadsSourceStatus, message: string, readonly retryAt: string | null = null) {
    super(message);
    this.name = "PackageDownloadsSourceError";
  }
}

export interface PackageDownloadRequest { readonly package: string; readonly from: string; readonly to: string; }
export interface PackageDownloadProvenance {
  readonly provider: "npm" | "pypistats" | "fixture";
  readonly interface: "npm_downloads_public_api" | "pypistats_public_api" | "recorded_fixture";
  readonly sourceRef: string;
  readonly retrievedAt: string;
  readonly caveat: string | null;
}
export interface CollectedPackageDownload {
  readonly id: string;
  readonly ecosystem: PackageEcosystem;
  readonly package: string;
  readonly subject: string;
  readonly day: string;
  readonly downloads: number;
  readonly provenance: PackageDownloadProvenance;
}
export interface PackageDownloadCollection {
  readonly ecosystem: PackageEcosystem;
  readonly package: string;
  readonly from: string;
  readonly to: string;
  readonly buckets: readonly CollectedPackageDownload[];
  readonly provenance: PackageDownloadProvenance;
  /** Days in the requested window with no provider row (never filled with synthetic zeros). */
  readonly missingDays: readonly string[];
  readonly coverageComplete: boolean;
}
export interface PackageDownloadsConnector {
  readonly ecosystem: PackageEcosystem;
  collect(request: PackageDownloadRequest): Promise<PackageDownloadCollection>;
}
