export interface QuantitativeProvenance {
  readonly url: string;
  readonly endpoint: string;
  readonly apiVersion: string;
  readonly retrievedAt: string;
}

/** Connector output for the quantitative lane; intentionally not a RawDocument/RawSignal. */
export interface CollectedMetricObservation {
  readonly id: string;
  readonly subject: string;
  readonly source: string;
  readonly metric: string;
  readonly geography: string | null;
  readonly observedAt: string;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly unit: "count";
  readonly collectionMethod: "authorized_public_api";
  readonly provenance: QuantitativeProvenance;
}

export interface QuantitativeCollectionRequest {
  readonly subject: string;
  readonly since?: string;
}

export interface QuantitativeConnectorHealth {
  readonly ok: boolean;
  readonly message?: string;
}

export interface QuantitativeConnector {
  readonly source: string;
  healthcheck(): Promise<QuantitativeConnectorHealth>;
  collect(request: QuantitativeCollectionRequest): Promise<readonly CollectedMetricObservation[]>;
}
