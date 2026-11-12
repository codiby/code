/**
 * Server-side headless browser. The bridge owns a single instance; its
 * profile lives under the agent's data dir because the agent is the session
 * whose logins it keeps (other sessions browse in throwaway contexts).
 */

import { MAIN_SESSION_ID } from '../config/config';
import { agentDataDir } from '../agent/store';
import { HeadlessBrowser } from './manager';

export { HeadlessBrowser, BrowserUnavailableError, NoHeadlessTabError, DEFAULT_COOKIE_JAR } from './manager';
export type { HeadlessStatus, HeadlessTabInfo, TabFallback } from './manager';
export { PageSession, BROWSER_ACTIONS, resolveRef } from './actions';
export type { BrowserAction } from './actions';
export { discoverChromium, chromiumCandidates } from './discovery';

let instance: HeadlessBrowser | null = null;

export function headlessBrowser(): HeadlessBrowser {
  if (!instance) {
    instance = new HeadlessBrowser({
      profileDir: agentDataDir('browser', 'profile'),
      isAgentSession: (sessionId) => sessionId === MAIN_SESSION_ID,
    });
  }
  return instance;
}

/** Tests only. */
export function _setHeadlessBrowserForTest(browser: HeadlessBrowser | null): void {
  instance = browser;
}
