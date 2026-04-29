// Standalone jsx-runtime served at /runtime/jsx-runtime.js. The importmap
// points `react/jsx-runtime` here so host + every plugin uses the same jsx
// factory.
//
// We deliberately do NOT re-export from `react/jsx-runtime`. React 19's
// `react-jsx-runtime.development.js` reassigns its module-local `React`
// binding (`var React = require('react'); ... React = {...}`). When `react`
// is externalised, Bun rewrites those references to the imported namespace
// alias, which is a frozen ESM binding — first JSX render then throws
// "Attempted to assign to readonly property". Implementing jsx ourselves
// from scratch sidesteps that bundler interaction entirely. The element
// symbols are `Symbol.for(...)` so they match React's own symbols across
// realms — elements we produce flow through React's reconciler unchanged.
const REACT_ELEMENT_TYPE = Symbol.for('react.transitional.element');
const REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');

function jsx(type, config, maybeKey) {
  let key = null;
  if (maybeKey !== undefined) key = '' + maybeKey;
  if (config.key !== undefined) key = '' + config.key;
  let props;
  if ('key' in config) {
    props = {};
    for (const propName in config) {
      if (propName !== 'key') props[propName] = config[propName];
    }
  } else {
    props = config;
  }
  const ref = props.ref;
  return {
    $$typeof: REACT_ELEMENT_TYPE,
    type,
    key,
    ref: ref !== undefined ? ref : null,
    props,
  };
}

export { REACT_FRAGMENT_TYPE as Fragment, jsx, jsx as jsxs };
export default { Fragment: REACT_FRAGMENT_TYPE, jsx, jsxs: jsx };
