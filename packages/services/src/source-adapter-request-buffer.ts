/**
 * Takes sole ownership of an adapter capture without retaining two full
 * response buffers. Exact, standalone ArrayBuffers can be transferred: the
 * adapter's view is detached before the canonical request crosses the generic
 * boundary. Pooled buffers, subarrays, and shared memory take the defensive
 * copy path so unrelated or concurrently mutable bytes never cross.
 */
export function takeProtectedRawResponse(bytes: Uint8Array): Uint8Array {
  const buffer = bytes.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return structuredClone(bytes, { transfer: [buffer] });
  }
  return new Uint8Array(bytes);
}
