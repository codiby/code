/**
 * Service-level gate for the Google tools. Runs before any network call so a
 * tool the owner hasn't allowed fails with a clear message instead of a vague
 * 403 — and so lowering a level in the UI takes effect immediately, even
 * though the stored token still carries the broader scopes.
 */

import { ToolInputError } from './args';
import { GoogleAuthError, grantedScopes, loadTokens } from './oauth';
import {
  calendarLevelAtLeast,
  calendarScopes,
  gmailLevelAtLeast,
  gmailScopes,
  loadGoogleSettings,
  type CalendarLevel,
  type GmailLevel,
} from './settings';

const WHERE = 'Codiby → Agent → Connections';

function requireScopes(needed: string[], service: string): void {
  if (!loadTokens()) {
    throw new GoogleAuthError('not_connected', `Google is not connected. Ask the owner to connect it in ${WHERE}.`);
  }
  const granted = new Set(grantedScopes());
  if (needed.some(s => !granted.has(s))) {
    throw new ToolInputError(
      `The Google connection was made before ${service} access was raised, so Google hasn't granted it yet. Ask the owner to click Reconnect in ${WHERE}.`,
    );
  }
}

export function requireGmail(tool: string, min: Exclude<GmailLevel, 'off'>): void {
  const level = loadGoogleSettings().gmail;
  if (level === 'off') throw new ToolInputError(`Gmail access is turned off. Ask the owner to enable it in ${WHERE}.`);
  if (!gmailLevelAtLeast(level, min)) {
    // Drafting is the safe fallback for a send the owner hasn't allowed.
    const hint = min === 'send' && level === 'draft'
      ? ' Use gmail_draft instead so the owner can review and send it, or ask them to raise Gmail access to "send".'
      : ` Ask the owner to raise it in ${WHERE}.`;
    throw new ToolInputError(`${tool} needs Gmail access "${min}" (currently "${level}").${hint}`);
  }
  requireScopes(gmailScopes(min), 'Gmail');
}

export function requireCalendar(tool: string, min: Exclude<CalendarLevel, 'off'>): void {
  const level = loadGoogleSettings().calendar;
  if (level === 'off') throw new ToolInputError(`Calendar access is turned off. Ask the owner to enable it in ${WHERE}.`);
  if (!calendarLevelAtLeast(level, min)) {
    throw new ToolInputError(`${tool} needs Calendar access "${min}" (currently "${level}"). Ask the owner to raise it in ${WHERE}.`);
  }
  requireScopes(calendarScopes(min), 'Calendar');
}
