/**
 * Live view of the bridge's headless browser for the Agent → Browser tab.
 * All routes require the bridge's normal auth.
 */

import { corsHeaders } from '../../config/config';
import { headlessBrowser } from '../../browser';
import { isValidPreviewName } from '../../provider/browser-cdp';
import { errorJson, json } from '../http';
import { AGENT_SESSION_ID } from '../session';
import type { AgentRoute } from '../types';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const browserRoutes: AgentRoute[] = [
  {
    method: 'GET',
    path: '/agent/browser/status',
    handler: async () => json(await headlessBrowser().status()),
  },
  {
    method: 'GET',
    path: '/agent/browser/screenshot',
    handler: async (_req, _params, url) => {
      const sessionId = url.searchParams.get('sessionId') || AGENT_SESSION_ID;
      if (!SESSION_ID_RE.test(sessionId)) return errorJson('Invalid sessionId');
      const browser = headlessBrowser();
      let name = url.searchParams.get('name') || '';
      if (name && !isValidPreviewName(name)) return errorJson('Invalid tab name');
      if (!name) {
        // Without a name, show the session's most recently used live tab.
        const live = browser.listTabs(sessionId).filter(t => t.live).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        if (!live.length) return errorJson('No live browser tab for this session', 404);
        name = live[0]!.name;
      }
      let shot: Buffer | null;
      try {
        shot = await browser.liveScreenshot(sessionId, name);
      } catch (err) {
        return errorJson(`Could not capture the tab: ${err instanceof Error ? err.message : String(err)}`, 502);
      }
      if (!shot) return errorJson('That tab is not live (the browser is stopped or the tab was closed)', 404);
      return new Response(new Uint8Array(shot), {
        headers: { ...corsHeaders, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
      });
    },
  },
  {
    method: 'POST',
    path: '/agent/browser/stop',
    handler: async () => {
      const stopped = await headlessBrowser().stop('stopped from the app');
      return json({ ok: true, stopped });
    },
  },
];
