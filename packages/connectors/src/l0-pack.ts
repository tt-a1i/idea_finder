import type { SourceConnector } from "./ports/source-connector.js";
import { createAppStoreRssConnector, type AppStoreRssConnectorOptions } from "./connectors/app-store-rss.js";
import { createHnAlgoliaConnector, type HnAlgoliaConnectorOptions } from "./connectors/hn-algolia.js";
import { createManualImportConnector } from "./connectors/manual-import.js";
import { createStackExchangeConnector, type StackExchangeConnectorOptions } from "./connectors/stack-exchange.js";
import { createV2exConnector, type V2exConnectorOptions } from "./connectors/v2ex.js";
import type { FetchOptions } from "./lib/fetch.js";

export interface L0ConnectorPackOptions {
  readonly fetch?: FetchOptions;
  readonly hn?: HnAlgoliaConnectorOptions;
  readonly v2ex?: V2exConnectorOptions;
  readonly appStore?: AppStoreRssConnectorOptions;
  readonly stackExchange?: StackExchangeConnectorOptions;
}

/** Default L0 connector pack — public APIs/RSS only, no secrets required. */
export function createL0ConnectorPack(options: L0ConnectorPackOptions = {}): SourceConnector[] {
  const shared = options.fetch ?? {};
  return [
    createHnAlgoliaConnector({ ...shared, ...options.hn }),
    createV2exConnector({ ...shared, ...options.v2ex }),
    createAppStoreRssConnector({ ...shared, ...options.appStore }),
    createStackExchangeConnector({ ...shared, ...options.stackExchange }),
    createManualImportConnector(),
  ];
}

export function connectorByPlatform(
  connectors: readonly SourceConnector[],
  platform: string,
): SourceConnector | undefined {
  return connectors.find((c) => c.platform === platform);
}
