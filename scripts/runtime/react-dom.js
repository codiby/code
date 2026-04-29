// Single ReactDOM bundle covering BOTH `react-dom` and `react-dom/client`. The
// importmap maps both bare specifiers to this same file (see scripts/build.ts),
// so any consumer — host or plugin — sees one ReactDOM instance with one
// reconciler. Splitting them across two files would give createRoot and
// createPortal independent renderer state, which silently breaks portals.
//
// `react` is externalised at build time and resolves to /runtime/react.js
// via the importmap, preserving single-React identity for hooks.
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';

export default ReactDOM;

// `react-dom` surface
export const {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version,
  __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
} = ReactDOM;

// `react-dom/client` surface (`version` already exported above; ReactDOMClient.version
// is the same string so we deliberately skip the duplicate export to avoid an
// ESM "duplicate name" error).
export const {
  createRoot,
  hydrateRoot,
} = ReactDOMClient;
