import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../project/project-root.js';
import { defaultDatabasePath } from '../project/data-directory.js';
import { WireQuillError } from '../utils/errors.js';
import {
  CONFIG_FILE_NAME,
  DATA_DIRECTORY_NAME,
  DEFAULTS,
  DEFAULT_CAPTURE_EXCLUDE,
  DEFAULT_CAPTURE_INCLUDE,
  DEFAULT_IGNORE_METHODS,
} from './defaults.js';
import { configFileSchema, formatZodIssues, type ConfigFile } from './schema.js';
import { parseTargetUrl } from './target.js';
import type { WireQuillConfig } from './types.js';

/** Raw values coming from commander, before any validation. */
export interface CliOptions {
  target?: string | undefined;
  port?: string | number | undefined;
  docsPort?: string | number | undefined;
  host?: string | undefined;
  config?: string | undefined;
  db?: string | undefined;
  maxBody?: string | number | undefined;
  insecure?: boolean | undefined;
  open?: boolean | undefined;
  verbose?: boolean | undefined;
}

export interface LoadConfigContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the effective configuration.
 *
 * Precedence is CLI > environment > config file > defaults (spec section 17).
 * The function is pure with respect to the filesystem apart from reading the
 * config file: creating directories is the runtime's job.
 */
export function loadConfig(options: CliOptions, context: LoadConfigContext = {}): WireQuillConfig {
  const cwd = context.cwd ?? process.cwd();
  const env = context.env ?? process.env;

  const project = findProjectRoot(cwd);
  const { file, filePath } = readConfigFile(options.config, cwd, project.root);

  const target = firstDefined(options.target, env.WIREQUILL_TARGET, file?.target);
  if (target === undefined) {
    throw new WireQuillError(
      'MISSING_TARGET',
      'No target specified.',
      'Run: wirequill --target http://localhost:8080',
    );
  }

  const proxyPort = resolvePort(
    firstDefined(options.port, env.WIREQUILL_PORT, file?.proxy?.port),
    DEFAULTS.proxyPort,
    '--port',
  );

  const docsPort = resolvePort(
    firstDefined(options.docsPort, env.WIREQUILL_DOCS_PORT, file?.docs?.port),
    DEFAULTS.docsPort,
    '--docs-port',
  );

  if (proxyPort === docsPort) {
    throw new WireQuillError(
      'PORT_COLLISION',
      `The proxy port and the docs port are both ${String(proxyPort)}.`,
      'Give them different values, for example --port 3000 --docs-port 3001.',
    );
  }

  const proxyHost =
    firstDefined(options.host, env.WIREQUILL_HOST, file?.proxy?.host) ?? DEFAULTS.proxyHost;

  const maxBodyBytes = resolveByteCount(
    firstDefined(options.maxBody, env.WIREQUILL_MAX_BODY, file?.capture?.maxBodyBytes),
    DEFAULTS.maxBodyBytes,
    '--max-body',
  );

  const maxDecompressedBodyBytes = resolveByteCount(
    file?.capture?.maxDecompressedBodyBytes,
    DEFAULTS.maxDecompressedBodyBytes,
    'capture.maxDecompressedBodyBytes',
  );

  const globalCaptureBudgetBytes = resolveByteCount(
    file?.capture?.globalCaptureBudgetBytes,
    DEFAULTS.globalCaptureBudgetBytes,
    'capture.globalCaptureBudgetBytes',
  );

  const databasePath = resolveDatabasePath(
    firstDefined(options.db, env.WIREQUILL_DB, file?.storage?.databasePath),
    cwd,
    project.root,
  );

  return {
    target: parseTargetUrl(target),

    proxy: {
      host: proxyHost,
      port: proxyPort,
      insecure: options.insecure ?? file?.proxy?.insecure ?? false,
    },

    docs: {
      host: DEFAULTS.docsHost,
      port: docsPort,
      title: file?.docs?.title ?? undefined,
      openBrowser: options.open ?? file?.docs?.openBrowser ?? true,
    },

    capture: {
      maxBodyBytes,
      maxDecompressedBodyBytes,
      globalCaptureBudgetBytes,
      maxPendingObservations:
        file?.capture?.maxPendingObservations ?? DEFAULTS.maxPendingObservations,
      include: file?.capture?.include ?? [...DEFAULT_CAPTURE_INCLUDE],
      exclude: file?.capture?.exclude ?? [...DEFAULT_CAPTURE_EXCLUDE],
      ignoreMethods: normalizeMethods(file?.capture?.ignoreMethods ?? [...DEFAULT_IGNORE_METHODS]),
    },

    redaction: {
      fields: file?.redaction?.fields ?? [],
      headers: file?.redaction?.headers ?? [],
      query: file?.redaction?.query ?? [],
    },

    inference: {
      requiredAfterSamples: file?.inference?.requiredAfterSamples ?? DEFAULTS.requiredAfterSamples,
      maxDepth: file?.inference?.maxDepth ?? DEFAULTS.maxSchemaDepth,
      maxProperties: file?.inference?.maxProperties ?? DEFAULTS.maxObjectProperties,
      maxSchemaNodes: file?.inference?.maxSchemaNodes ?? DEFAULTS.maxSchemaNodes,
      maxArrayItems: file?.inference?.maxArrayItems ?? DEFAULTS.maxArrayItemsInspected,
    },

    storage: {
      databasePath,
      maxObservations: file?.storage?.maxObservations ?? DEFAULTS.maxObservations,
      maxExamplesPerBucket: file?.storage?.maxExamplesPerBucket ?? DEFAULTS.maxExamplesPerBucket,
    },

    verbose: options.verbose ?? false,

    sources: {
      projectRoot: project.root,
      configFilePath: filePath,
      dataDirectory: path.join(project.root, DATA_DIRECTORY_NAME),
      packageName: project.packageName,
    },
  };
}

function readConfigFile(
  explicitPath: string | undefined,
  cwd: string,
  projectRoot: string,
): { file: ConfigFile | null; filePath: string | null } {
  const filePath =
    explicitPath !== undefined
      ? path.resolve(cwd, explicitPath)
      : path.join(projectRoot, CONFIG_FILE_NAME);

  if (!existsSync(filePath)) {
    if (explicitPath !== undefined) {
      throw new WireQuillError(
        'CONFIG_NOT_FOUND',
        `Config file not found:\n${filePath}`,
        'Check the --config path, or omit the flag to use defaults.',
      );
    }
    return { file: null, filePath: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new WireQuillError(
      'CONFIG_INVALID_JSON',
      `Config file is not valid JSON:\n${filePath}\n\n${error instanceof Error ? error.message : String(error)}`,
      'Fix the JSON syntax and try again.',
    );
  }

  const result = configFileSchema.safeParse(raw);
  if (!result.success) {
    throw new WireQuillError(
      'CONFIG_INVALID',
      `Config file is not valid:\n${filePath}\n\n${formatZodIssues(result.error)}`,
      'See wirequill.config.example.json for the supported shape.',
    );
  }

  return { file: result.data, filePath };
}

function resolveDatabasePath(
  candidate: string | undefined,
  cwd: string,
  projectRoot: string,
): string {
  if (candidate === undefined) {
    return defaultDatabasePath(projectRoot);
  }
  return path.resolve(cwd, candidate);
}

function resolvePort(value: string | number | undefined, fallback: number, flag: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = toInteger(value);
  if (parsed === null || parsed < 1 || parsed > 65_535) {
    throw new WireQuillError(
      'INVALID_PORT',
      `Invalid value for ${flag}: ${String(value)}`,
      'A port must be a whole number between 1 and 65535.',
    );
  }

  return parsed;
}

function resolveByteCount(
  value: string | number | undefined,
  fallback: number,
  flag: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = toInteger(value);
  if (parsed === null || parsed <= 0) {
    throw new WireQuillError(
      'INVALID_BYTE_COUNT',
      `Invalid value for ${flag}: ${String(value)}`,
      'Provide a positive whole number of bytes.',
    );
  }

  return parsed;
}

function toInteger(value: string | number): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }

  const trimmed = value.trim();
  if (trimmed === '' || !/^[0-9]+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeMethods(methods: string[]): string[] {
  return methods.map((method) => method.toUpperCase());
}

function firstDefined<T>(...values: (T | undefined | null | '')[]): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}
