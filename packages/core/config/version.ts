import pkg from '../../../package.json';

/** The release this bridge was built from — the same `package.json` version the
 *  GitHub release is tagged with (`v<version>`). A static import, so the bundled
 *  `server.js` inside the macOS app carries it without a `package.json` beside it. */
export const APP_VERSION: string = pkg.version;
