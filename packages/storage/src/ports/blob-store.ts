export interface BlobRef {
  readonly hash: string;
  readonly path: string;
}

export interface BlobStore {
  put(content: Uint8Array): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array | null>;
}
