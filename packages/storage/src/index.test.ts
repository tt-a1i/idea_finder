import { describe, expect, it } from "vitest";

import type { BlobStore } from "./index.js";

describe("@idea-finder/storage", () => {
  it("defines BlobStore port shape", () => {
    const store = {} as BlobStore;
    expect(store.put).toBeUndefined();
  });
});
