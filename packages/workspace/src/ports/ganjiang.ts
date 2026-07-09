import type { WorkspaceState } from "../types.js";

/**
 * Ganjiang persistence port — durable storage for runs, evidence, and library state.
 * Wave 2 uses local JSON files; swap this port when @idea-finder/storage is wired.
 */
export interface GanjiangStoragePort {
  loadState(): Promise<WorkspaceState>;
  saveState(state: WorkspaceState): Promise<void>;
}

export function createFileGanjiangPort(
  load: () => Promise<WorkspaceState>,
  save: (state: WorkspaceState) => Promise<void>,
): GanjiangStoragePort {
  return { loadState: load, saveState: save };
}
