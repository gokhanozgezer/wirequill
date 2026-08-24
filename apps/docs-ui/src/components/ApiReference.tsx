import { useMemo } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import type { OpenApiDocument } from '../api/types.js';
import { SCALAR_CONFIGURATION } from '../scalar-configuration.js';

/**
 * The API reference.
 *
 * Everything about how Scalar is configured — and why each switch is off —
 * lives in `scalar-configuration.ts`.
 */

export interface ApiReferenceProps {
  document: OpenApiDocument;
  /**
   * Remount key.
   *
   * The React wrapper does call `updateConfiguration` when the configuration
   * object changes, but a controlled remount is the behaviour the brief
   * sanctions and the one that cannot silently render a stale contract
   * (spec section 85). The cost is scroll position, and it is only paid when
   * the documentation actually changed: the revision does not move for traffic
   * that teaches the document nothing (spec sections 86 and 180).
   */
  revision: number;
}

export function ApiReference({ document, revision }: ApiReferenceProps) {
  const configuration = useMemo(() => ({ ...SCALAR_CONFIGURATION, content: document }), [document]);

  return (
    <div className="quill-reference quill-enter flex-1" data-testid="api-reference">
      <ApiReferenceReact key={revision} configuration={configuration} />
    </div>
  );
}
