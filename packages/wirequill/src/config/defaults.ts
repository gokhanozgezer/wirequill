/**
 * Default configuration values (spec section 15).
 *
 * These are the numbers WireQuill runs with when the user supplies nothing but
 * a target. They are deliberately conservative: bounded memory beats complete
 * capture.
 */
export const DEFAULTS = {
  proxyHost: '127.0.0.1',
  proxyPort: 3000,
  docsHost: '127.0.0.1',
  docsPort: 3001,

  maxBodyBytes: 1_048_576,
  maxDecompressedBodyBytes: 2_097_152,
  globalCaptureBudgetBytes: 33_554_432,

  /** Observations awaiting parsing and redaction before new ones are dropped. */
  maxPendingObservations: 1_000,

  requiredAfterSamples: 3,
  maxExamplesPerBucket: 3,
  maxObservations: 20_000,

  maxSchemaDepth: 12,
  maxObjectProperties: 250,
  maxSchemaNodes: 5_000,
  maxArrayItemsInspected: 100,
} as const;

/** Directory created under the project root to hold all WireQuill state. */
export const DATA_DIRECTORY_NAME = '.wirequill';

/** Database file name inside the data directory. */
export const DATABASE_FILE_NAME = 'wirequill.sqlite';

/** Config file looked up from the project root. */
export const CONFIG_FILE_NAME = 'wirequill.config.json';

export const DEFAULT_CAPTURE_INCLUDE: readonly string[] = ['/**'];

/**
 * Static assets are proxied like everything else, they are simply not worth
 * documenting as API operations.
 */
export const DEFAULT_CAPTURE_EXCLUDE: readonly string[] = [
  '/**/*.js',
  '/**/*.css',
  '/**/*.map',
  '/**/*.png',
  '/**/*.jpg',
  '/**/*.svg',
  '/**/*.woff2',
];

export const DEFAULT_IGNORE_METHODS: readonly string[] = ['OPTIONS'];
