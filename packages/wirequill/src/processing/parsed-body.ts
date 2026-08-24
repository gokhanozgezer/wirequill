import type { IncomingHttpHeaders } from 'node:http';
import type { BodyCaptureResult } from '../capture/body-capture.js';
import {
  classifyMediaType,
  isSupportedCharset,
  parseContentEncoding,
  parseContentType,
} from '../capture/content-type.js';
import { decompressCapturedBody } from './decompress.js';

/**
 * The result of trying to understand a captured body (spec section 158).
 *
 * `reason` is always a fixed label. It must never quote the payload: a parser's
 * own error text routinely embeds the offending input, which for a malformed
 * login body means the password ends up in a log line.
 */
export type ParsedBody =
  | { kind: 'none' }
  | { kind: 'json'; mediaType: string; value: unknown }
  | { kind: 'form'; mediaType: string; value: Record<string, string | string[]> }
  | { kind: 'unsupported'; mediaType?: string | undefined; reason: string }
  | { kind: 'truncated'; mediaType?: string | undefined }
  | { kind: 'invalid'; mediaType?: string | undefined; reason: string };

/** Short, stable labels stored in `*_parse_status` columns. */
export function parseStatusOf(body: ParsedBody): string {
  switch (body.kind) {
    case 'none':
      return 'none';
    case 'json':
      return 'json';
    case 'form':
      return 'form';
    case 'truncated':
      return 'truncated';
    case 'unsupported':
      return body.reason;
    case 'invalid':
      return body.reason;
  }
}

export interface ParseBodyOptions {
  headers: IncomingHttpHeaders | undefined;
  capture: BodyCaptureResult | undefined;
  maxDecompressedBytes: number;
  aborted?: boolean;
}

export function parseCapturedBody(options: ParseBodyOptions): ParsedBody {
  const { capture, headers } = options;

  if (capture === undefined) {
    return { kind: 'none' };
  }

  const contentType = parseContentType(headerValue(headers?.['content-type']));
  const mediaType = contentType?.mediaType;

  if (options.aborted === true) {
    return { kind: 'unsupported', mediaType, reason: 'aborted' };
  }

  if (capture.totalBytes === 0) {
    return { kind: 'none' };
  }

  const kind = classifyMediaType(mediaType);

  if (kind === 'multipart') {
    return { kind: 'unsupported', mediaType, reason: 'unsupported_multipart' };
  }

  if (kind === 'binary') {
    return { kind: 'unsupported', mediaType, reason: 'unsupported_binary' };
  }

  if (kind === 'event-stream') {
    return { kind: 'unsupported', mediaType, reason: 'unsupported_event_stream' };
  }

  if (kind === 'text') {
    // Privacy-first default (spec section 28): free text is forwarded, counted,
    // and otherwise left alone.
    return { kind: 'unsupported', mediaType, reason: 'text_not_analyzed' };
  }

  if (kind !== 'json' && kind !== 'form') {
    return { kind: 'unsupported', mediaType, reason: 'unsupported_media_type' };
  }

  if (capture.budgetExceeded) {
    return { kind: 'truncated', mediaType };
  }

  if (capture.truncated) {
    // Half a JSON document parses as nothing useful and guessing at the rest
    // would invent structure that was never observed.
    return { kind: 'truncated', mediaType };
  }

  if (capture.buffer === null) {
    return { kind: 'unsupported', mediaType, reason: 'not_captured' };
  }

  if (!isSupportedCharset(contentType?.charset)) {
    return { kind: 'unsupported', mediaType, reason: 'unsupported_charset' };
  }

  const encoding = parseContentEncoding(headerValue(headers?.['content-encoding']));
  const decompressed = decompressCapturedBody(
    capture.buffer,
    encoding,
    options.maxDecompressedBytes,
  );

  if (!decompressed.ok) {
    return decompressed.reason === 'decompressed_too_large'
      ? { kind: 'invalid', mediaType, reason: 'decompressed_too_large' }
      : { kind: 'invalid', mediaType, reason: decompressed.reason };
  }

  if (decompressed.buffer.byteLength > options.maxDecompressedBytes) {
    return { kind: 'invalid', mediaType, reason: 'decompressed_too_large' };
  }

  return kind === 'json'
    ? parseJson(decompressed.buffer, mediaType ?? 'application/json')
    : parseForm(decompressed.buffer, mediaType ?? 'application/x-www-form-urlencoded');
}

function parseJson(buffer: Buffer, mediaType: string): ParsedBody {
  const text = stripByteOrderMark(buffer.toString('utf8')).trim();

  if (text === '') {
    return { kind: 'none' };
  }

  try {
    return { kind: 'json', mediaType, value: JSON.parse(text) };
  } catch {
    // The parser's message is discarded on purpose; it quotes the input.
    return { kind: 'invalid', mediaType, reason: 'invalid_json' };
  }
}

function parseForm(buffer: Buffer, mediaType: string): ParsedBody {
  const params = new URLSearchParams(buffer.toString('utf8'));
  const value: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;

  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    const single = all[0];
    value[key] = all.length === 1 && single !== undefined ? single : all;
  }

  return { kind: 'form', mediaType, value };
}

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
