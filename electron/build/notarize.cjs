/**
 * electron-builder afterSign hook — notarises the macOS .app bundle.
 *
 * Skipped silently when any of APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
 * APPLE_TEAM_ID is missing, so local dev builds work without notarisation
 * credentials. Notarisation requires hardenedRuntime + the entitlements
 * declared in entitlements.mac.plist (electron-builder wires these up
 * from the `mac` block in package.json).
 */
const path = require('node:path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set — skipping.');
    return;
  }

  const { notarize } = require('@electron/notarize');
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] Notarising ${appPath} as ${appleId} on team ${teamId}…`);
  await notarize({
    appBundleId: packager.appInfo.id,
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  console.log('[notarize] done.');
};
