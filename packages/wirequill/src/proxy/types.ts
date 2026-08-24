export interface ProxyAddress {
  host: string;
  port: number;
}

/**
 * The transport WireQuill puts between a client and the target backend.
 *
 * Kept as an interface so the runtime can be driven with a stub in tests, and
 * so the transport implementation can be replaced without the composition root
 * knowing.
 */
export interface ProxyServer {
  /** Resolves only once the socket is actually accepting connections. */
  start(): Promise<void>;
  /** Safe to call more than once, and safe to call before `start()`. */
  stop(): Promise<void>;
  address(): ProxyAddress;
  /** Open protocol-upgrade tunnels, for leak assertions. Optional for stubs. */
  readonly tunnelCount?: number;
}
