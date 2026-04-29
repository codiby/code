// Dev variant served at /runtime/jsx-dev-runtime.js. Some host modules and
// many third-party packages still emit `jsxDEV(...)` calls regardless of our
// minify flag, so the importmap maps `react/jsx-dev-runtime` here.
//
// We do NOT use React's `react-jsx-dev-runtime.development.js` (it
// reassigns its module-local `React` binding, which Bun rewrites onto the
// frozen externalised namespace and crashes at module-eval time). The
// production CJS variant exports `jsxDEV: undefined`, which is also
// unusable. So jsxDEV is just an alias of the prod-shape jsx — we drop
// dev-only owner-stack tracking but element creation is identical.
import { jsx, Fragment } from './jsx-runtime.js';

export { Fragment };
export const jsxDEV = jsx;
export default { Fragment, jsxDEV };
