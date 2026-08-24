import type { JsonSchema } from '../inference/schema/materialize-schema.js';

/**
 * A deliberately small OpenAPI 3.1 model.
 *
 * Only the parts WireQuill can fill from observed traffic exist here. There is
 * no `deprecated`, no `callbacks`, no `links`, no `requestBody.required` — not
 * because they were forgotten, but because nothing in a stream of HTTP requests
 * proves them.
 */

export type ParameterLocation = 'path' | 'query' | 'header';

export interface OpenApiParameter {
  name: string;
  in: ParameterLocation;
  required?: boolean;
  schema: JsonSchema;
  example?: unknown;
}

export interface OpenApiMediaType {
  schema?: JsonSchema;
  example?: unknown;
}

export interface OpenApiRequestBody {
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

/** `{ bearerAuth: [] }` — scheme name to scopes, which are always empty here. */
export type OpenApiSecurityRequirement = Record<string, string[]>;

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  security?: OpenApiSecurityRequirement[];
  requestBody?: OpenApiRequestBody;
  /**
   * Omitted when nothing has been observed.
   *
   * OpenAPI 3.1 made `responses` optional but still rejects an empty object,
   * so an operation whose only response was WireQuill's own 502 carries none at
   * all rather than an empty map.
   */
  responses?: Record<string, OpenApiResponse>;
}

export type OpenApiPathItem = Record<string, OpenApiOperation>;

export interface OpenApiSecurityScheme {
  type: 'http' | 'apiKey';
  scheme?: 'bearer' | 'basic';
  in?: 'header' | 'query';
  name?: string;
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description: string;
}

export interface OpenApiServer {
  url: string;
}

export interface WireQuillExtension {
  source: 'observed-http-traffic';
  revision: number;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  servers: OpenApiServer[];
  paths: Record<string, OpenApiPathItem>;
  components?: {
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  'x-wirequill': WireQuillExtension;
}

/**
 * One operation, materialised but not yet placed in a document.
 *
 * Kept separate from the storage row so that the database model and the public
 * contract can evolve independently, and so a public shape can be fingerprinted
 * without a document around it (spec section 71).
 */
export interface PublicOperation {
  /** Lower-case, as OpenAPI path items require. */
  method: string;
  path: string;
  operation: OpenApiOperation;
  /** Schemes this operation needs, to be collected into `components`. */
  securitySchemes: Record<string, OpenApiSecurityScheme>;
}

/**
 * Canonical method ordering inside a path item (spec section 73).
 *
 * OPTIONS is present for completeness; it is filtered out of discovery by
 * default and normally never appears.
 */
export const METHOD_ORDER: readonly string[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
];
