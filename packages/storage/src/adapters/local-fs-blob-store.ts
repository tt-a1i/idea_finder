import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";

import type { BlobRef, BlobStore } from "../ports/blob-store.js";

export class LocalFsBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  async put(content: Uint8Array): Promise<BlobRef> {
    const hash = createHash("sha256").update(content).digest("hex");
    const relative = join(hash.slice(0, 2), hash.slice(2, 4), hash);
    const path = join(this.rootDir, relative);
    await mkdir(dirname(path), { recursive: true });

    try {
      await access(path);
    } catch {
      await writeFile(path, content);
    }

    return { hash, path };
  }

  async get(ref: BlobRef): Promise<Uint8Array | null> {
    try {
      const buffer = await readFile(ref.path);
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }
}
