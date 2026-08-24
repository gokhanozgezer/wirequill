/**
 * Fully resolved runtime configuration (spec section 157).
 *
 * Every value is concrete by the time a `WireQuillConfig` exists: defaults have
 * been applied, the target has been validated and paths have been made
 * absolute. Nothing downstream re-reads the environment or the config file.
 */
export interface WireQuillConfig {
  target: URL;

  proxy: {
    host: string;
    port: number;
    insecure: boolean;
  };

  docs: {
    /** Hard-pinned in v0.1: docs must never be exposed to the LAN. */
    host: '127.0.0.1';
    port: number;
    title?: string | undefined;
    openBrowser: boolean;
  };

  capture: {
    maxBodyBytes: number;
    maxDecompressedBodyBytes: number;
    globalCaptureBudgetBytes: number;
    maxPendingObservations: number;
    include: string[];
    exclude: string[];
    ignoreMethods: string[];
  };

  redaction: {
    fields: string[];
    headers: string[];
    query: string[];
  };

  inference: {
    requiredAfterSamples: number;
    maxDepth: number;
    maxProperties: number;
    maxSchemaNodes: number;
    maxArrayItems: number;
  };

  storage: {
    databasePath: string;
    maxObservations: number;
    maxExamplesPerBucket: number;
  };

  /** Diagnostic metadata only; never raw bodies or header values. */
  verbose: boolean;

  /** Where the resolved configuration came from, for `--verbose` reporting. */
  sources: ConfigSources;
}

export interface ConfigSources {
  projectRoot: string;
  configFilePath: string | null;
  dataDirectory: string;
  /** `name` from the nearest package.json, used to title generated docs. */
  packageName: string | null;
}
