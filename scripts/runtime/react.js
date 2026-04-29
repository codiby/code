// Shared React runtime — served at /runtime/react.js, mapped by the importmap.
// This is the ONE place React lives; every other runtime stub (react-dom,
// jsx-runtime, jsx-dev-runtime, react-dom/client) externalises `react` so they
// resolve back here, guaranteeing a single React identity for host + plugins.
//
// Why the explicit enumeration: Bun's CJS→ESM interop produces a default-only
// namespace for `import * as React from 'react'`, so `export *` synthesises
// nothing. Static `import { useEffect } from 'react'` in any consumer bundle
// would fail with "Importing binding name 'useEffect' is not found." We
// re-declare every public binding (and the internals react-dom needs) as
// real named exports of this stub.
import * as React from 'react';

export default React;

export const {
  // Public components / utilities
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  unstable_useCacheRefresh,
  use,
  // Hooks
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
  // Internals — react-dom looks these up via named import. Without them,
  // the externalised react-dom stub crashes at module-eval time.
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  __COMPILER_RUNTIME,
} = React;
