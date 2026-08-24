/**
 * Public entry point for programmatic use.
 *
 * The CLI is the supported interface in v0.1; these exports exist so tests and
 * future tooling can drive the runtime directly without shelling out.
 */

export { WIREQUILL_VERSION } from './version.js';

export { loadConfig, type CliOptions, type LoadConfigContext } from './config/load-config.js';
export { parseTargetUrl, normalizeTargetUrl } from './config/target.js';
export { DEFAULTS } from './config/defaults.js';
export { configFileSchema, type ConfigFile } from './config/schema.js';
export type { WireQuillConfig, ConfigSources } from './config/types.js';

export { findProjectRoot, type ProjectInfo } from './project/project-root.js';
export { ensureDataDirectory, defaultDatabasePath } from './project/data-directory.js';

export {
  WireQuillRuntime,
  type RuntimeOptions,
  type RuntimeState,
} from './runtime/wirequill-runtime.js';
export {
  CapturePipeline,
  type CapturePipelineOptions,
  type CapturePipelineStats,
} from './runtime/capture-pipeline.js';
export {
  openInBrowser,
  shouldOpenBrowser,
  isContinuousIntegration,
  type BrowserOpener,
} from './runtime/open-browser.js';
export { RateLimiter } from './utils/rate-limiter.js';
export {
  installSignalHandlers,
  type ShutdownSignal,
  type SignalHandlerHandle,
} from './runtime/lifecycle.js';

export * from './capture/index.js';
export * from './inference/schema/index.js';
export * from './examples/index.js';
export * from './openapi/index.js';
export * from './processing/index.js';
export * from './redaction/index.js';
export * from './proxy/index.js';
export * from './events/index.js';
export * from './docs-server/index.js';

export { Output, type OutputStreams } from './cli/output.js';
export { runCli, createProgram, type RunCliOptions } from './cli/index.js';

export * from './storage/index.js';

export { WireQuillError, isWireQuillError } from './utils/errors.js';
export { stableStringify } from './utils/stable-json.js';
export { sanitizeTerminalText } from './utils/terminal.js';
export { systemClock, fixedClock, toIsoString, type Clock } from './utils/clock.js';
export { sha256Hex, deriveWorkspaceId, uuidGenerator, type IdGenerator } from './utils/ids.js';
