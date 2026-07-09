/**
 * Bisheng connector port — harvest/fetch boundary.
 * Implementation deferred to connectors + harvest packages.
 */
export interface BishengConnectorPort {
  /** Platform identifiers this connector can fetch (e.g. hn, reddit). */
  readonly supportedPlatforms: readonly string[];
  /** Whether live fetch is available in the current environment. */
  isLive(): boolean;
}

export const bishengConnectorPort: BishengConnectorPort = {
  supportedPlatforms: ["hn", "reddit", "producthunt"],
  isLive(): boolean {
    return false;
  },
};
