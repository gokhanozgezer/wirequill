import { z } from 'zod';

/**
 * Shape of `wirequill.config.json`.
 *
 * Everything is optional: the file only overrides defaults. Unknown keys are
 * rejected so a typo (`proxyPort` instead of `proxy.port`) surfaces as an error
 * instead of being silently ignored.
 */

const portSchema = z.number().int().min(1).max(65_535);
const byteCountSchema = z.number().int().positive();

export const configFileSchema = z
  .object({
    target: z.string().min(1).optional(),

    proxy: z
      .object({
        host: z.string().min(1).optional(),
        port: portSchema.optional(),
        insecure: z.boolean().optional(),
      })
      .strict()
      .optional(),

    docs: z
      .object({
        port: portSchema.optional(),
        title: z.string().min(1).optional(),
        openBrowser: z.boolean().optional(),
      })
      .strict()
      .optional(),

    capture: z
      .object({
        maxBodyBytes: byteCountSchema.optional(),
        maxDecompressedBodyBytes: byteCountSchema.optional(),
        globalCaptureBudgetBytes: byteCountSchema.optional(),
        maxPendingObservations: z.number().int().min(1).optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        ignoreMethods: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),

    redaction: z
      .object({
        fields: z.array(z.string()).optional(),
        headers: z.array(z.string()).optional(),
        query: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),

    inference: z
      .object({
        requiredAfterSamples: z.number().int().min(1).optional(),
        maxDepth: z.number().int().min(1).optional(),
        maxProperties: z.number().int().min(1).optional(),
        maxSchemaNodes: z.number().int().min(1).optional(),
        maxArrayItems: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),

    storage: z
      .object({
        databasePath: z.string().min(1).optional(),
        maxObservations: z.number().int().min(1).optional(),
        maxExamplesPerBucket: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

/** Turns a Zod issue list into a short, indented, human-readable block. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');
}
