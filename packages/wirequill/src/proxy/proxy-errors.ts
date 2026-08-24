import { WireQuillError, errorCode } from '../utils/errors.js';

/**
 * What the client is told when the target cannot be reached.
 *
 * Deliberately fixed and content-free. HTTP proxy error bodies are a classic
 * leak: the default `http-proxy-middleware` responder echoes the Host header
 * and the request URL back to the caller. WireQuill sends neither, along with
 * no stack trace, no local path and no configuration detail.
 */
export const UPSTREAM_ERROR_BODY = 'Bad Gateway';

export const UPSTREAM_ERROR_STATUS = 502;

/** Spec section 102: an unreachable target is a 502, never a crash. */
export interface UpstreamFailureDescription {
  statusCode: number;
  /** Node syscall code, or a stable fallback when the error carries none. */
  code: string;
}

export function describeUpstreamFailure(error: unknown): UpstreamFailureDescription {
  return {
    statusCode: UPSTREAM_ERROR_STATUS,
    code: errorCode(error) ?? 'EPROXYFAILED',
  };
}

/**
 * Spec section 98. WireQuill never silently picks another port: a proxy that
 * moves is worse than a proxy that refuses to start, because the client is
 * configured to point at a fixed address.
 */
export function portInUseError(host: string, port: number, target: string): WireQuillError {
  const suggestedPort = port + 10;

  return new WireQuillError(
    'PORT_IN_USE',
    `Port ${String(port)} is already in use.`,
    [
      'Try:',
      `wirequill --target ${target} --port ${String(suggestedPort)}`,
      '',
      `Or free the process listening on ${host}:${String(port)}.`,
    ].join('\n'),
  );
}

export function bindFailedError(host: string, port: number, reason: string): WireQuillError {
  return new WireQuillError(
    'PROXY_BIND_FAILED',
    `Could not listen on ${host}:${String(port)}.\n\n${reason}`,
    'Check that the host is valid and that you may bind that port.',
  );
}

/** Turns a listen failure into an actionable error rather than a raw stack. */
export function toBindError(
  error: unknown,
  host: string,
  port: number,
  target: string,
): WireQuillError {
  const code = errorCode(error);

  if (code === 'EADDRINUSE') {
    return portInUseError(host, port, target);
  }

  if (code === 'EACCES') {
    return new WireQuillError(
      'PORT_NOT_PERMITTED',
      `Port ${String(port)} requires elevated permissions.`,
      'Pick a port above 1024, for example --port 3010.',
    );
  }

  if (code === 'EADDRNOTAVAIL') {
    return new WireQuillError(
      'HOST_NOT_AVAILABLE',
      `The address ${host} is not available on this machine.`,
      'Use --host 127.0.0.1, or an address this machine actually owns.',
    );
  }

  return bindFailedError(host, port, error instanceof Error ? error.message : String(error));
}
