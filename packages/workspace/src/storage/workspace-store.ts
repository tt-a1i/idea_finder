import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GanjiangStoragePort } from "../ports/ganjiang.js";
import type { HuntingBrief, WorkspaceState } from "../types.js";
import { emptyWorkspaceState } from "../types.js";

const STATE_FILE = "state.json";
const BRIEFS_DIR = "briefs";

export interface WorkspacePaths {
  readonly root: string;
  readonly statePath: string;
  readonly briefsDir: string;
}

export function resolveWorkspacePaths(rootDir: string): WorkspacePaths {
  const root = path.resolve(rootDir);
  return {
    root,
    statePath: path.join(root, STATE_FILE),
    briefsDir: path.join(root, BRIEFS_DIR),
  };
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function createWorkspaceStore(paths: WorkspacePaths): GanjiangStoragePort & {
  listBriefs(): Promise<HuntingBrief[]>;
  saveBrief(brief: HuntingBrief): Promise<void>;
  getBrief(slugOrId: string): Promise<HuntingBrief | null>;
} {
  async function loadState(): Promise<WorkspaceState> {
    try {
      const raw = await readFile(paths.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
      return {
        ...emptyWorkspaceState(),
        ...parsed,
        validationExperiments: parsed.validationExperiments ?? {},
        monitorSchedules: parsed.monitorSchedules ?? {},
        agentTasks: parsed.agentTasks ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyWorkspaceState();
      }
      throw err;
    }
  }

  async function saveState(state: WorkspaceState): Promise<void> {
    await ensureDir(paths.root);
    await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function listBriefs(): Promise<HuntingBrief[]> {
    await ensureDir(paths.briefsDir);
    const entries = await readdir(paths.briefsDir);
    const briefs: HuntingBrief[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await readFile(path.join(paths.briefsDir, entry), "utf8");
      briefs.push(JSON.parse(raw) as HuntingBrief);
    }
    return briefs.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async function saveBrief(brief: HuntingBrief): Promise<void> {
    await ensureDir(paths.briefsDir);
    const filePath = path.join(paths.briefsDir, `${brief.slug}.json`);
    await writeFile(filePath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");
  }

  async function getBrief(slugOrId: string): Promise<HuntingBrief | null> {
    const briefs = await listBriefs();
    return (
      briefs.find((b) => b.slug === slugOrId || b.id === slugOrId) ?? null
    );
  }

  return {
    loadState,
    saveState,
    listBriefs,
    saveBrief,
    getBrief,
  };
}
