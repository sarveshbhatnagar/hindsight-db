/**
 * Small dense-vector helpers. Embeddings are stored as raw Float32 blobs in the
 * platform's native byte order (little-endian on every supported Node target).
 */

export type Embedding = number[] | Float32Array;

export function toFloat32(v: Embedding): Float32Array {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}

/** Reject empty vectors and non-finite components; they would poison similarity scores. */
export function assertFiniteEmbedding(v: Float32Array): void {
  if (v.length === 0) throw new TypeError("embedding must not be empty");
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) throw new TypeError(`embedding contains a non-finite value at index ${i}`);
  }
}

export function encodeEmbedding(v: Embedding): Buffer {
  const f = toFloat32(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeEmbedding(buf: Buffer | Uint8Array): Float32Array {
  // Zero-copy view when the blob is 4-byte aligned (the common case); otherwise copy.
  if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function l2norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

/** Cosine similarity in [-1, 1]. Returns 0 when either vector is zero-length or all zeros. */
export function cosine(a: Float32Array, b: Float32Array, normA?: number, normB?: number): number {
  if (a.length !== b.length) {
    throw new RangeError(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  const na = normA ?? l2norm(a);
  const nb = normB ?? l2norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}
