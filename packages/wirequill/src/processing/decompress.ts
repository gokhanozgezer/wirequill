import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Bounded decompression of a captured copy (spec sections 29, 30).
 *
 * A 200 KiB gzip payload can expand to 100 MiB. Node's `maxOutputLength` makes
 * the ceiling the decompressor's own concern, so the bomb is refused while it
 * inflates rather than after it has already been allocated.
 *
 * The bytes forwarded to the client are never touched by any of this; only the
 * capture copy is decoded, and only so its structure can be read.
 */

export type DecompressOutcome =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: 'decompressed_too_large' | 'invalid_encoding' | 'unsupported_encoding' };

export function decompressCapturedBody(
  buffer: Buffer,
  encoding: string | null,
  maxOutputBytes: number,
): DecompressOutcome {
  if (encoding === null) {
    return { ok: true, buffer };
  }

  const options = { maxOutputLength: maxOutputBytes };

  try {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        return { ok: true, buffer: gunzipSync(buffer, options) };

      case 'br':
        return { ok: true, buffer: brotliDecompressSync(buffer, options) };

      case 'deflate':
        return { ok: true, buffer: inflateDeflate(buffer, options) };

      default:
        return { ok: false, reason: 'unsupported_encoding' };
    }
  } catch (error) {
    if (isTooLarge(error)) {
      return { ok: false, reason: 'decompressed_too_large' };
    }
    // Includes the ordinary case of a truncated capture: the tail of the
    // stream was never kept, so it cannot inflate.
    return { ok: false, reason: 'invalid_encoding' };
  }
}

/**
 * `Content-Encoding: deflate` is ambiguous in the wild: some servers send a
 * zlib wrapper, others send a raw deflate stream. Try the standard form first.
 */
function inflateDeflate(buffer: Buffer, options: { maxOutputLength: number }): Buffer {
  try {
    return inflateSync(buffer, options);
  } catch (error) {
    if (isTooLarge(error)) {
      throw error;
    }
    return inflateRawSync(buffer, options);
  }
}

function isTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const { code } = error as { code: unknown };
  return code === 'ERR_BUFFER_TOO_LARGE' || code === 'ERR_ZLIB_MAX_OUTPUT_LENGTH_EXCEEDED';
}
