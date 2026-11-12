/**
 * What triggers a push: a permission request (the bridge emits one for every
 * session), its resolution (so the phone drops the stale notification), and
 * owner notifications (`notify_user`, reminders).
 *
 * Pushes only happen while the agent is enabled on this host — phones only
 * register with agent hosts, and a host that turned the agent off should go
 * quiet without the owner having to unregister every phone.
 */

import { logError } from '../../lib/logger';
import { isAgentEnabled } from '../config';
import { matchRoute, onApproval, onOwnerNotification, type OwnerNotification } from '../registry';
import { AGENT_SESSION_ID } from '../session';
import type { ApprovalRequestedEvent, ApprovalResolvedEvent } from '../types';
import { canPush, pushToDevices } from './sender';
import { loadPushSettings } from './settings';

/**
 * Requests being pushed. The resolution waits for the request's push so it
 * can never overtake it, and a request answered before its push went out
 * (answered on the desktop within the same tick) is not pushed at all.
 */
interface PushedApproval {
  at: number;
  sessionId: string;
  sessionName: string;
  resolved: boolean;
  /** Resolves to whether the request reached FCM for at least one device. */
  sending: Promise<boolean>;
}
const pushed = new Map<string, PushedApproval>();
const FORGET_AFTER_MS = 24 * 3600_000;
const LOOKUP_TIMEOUT_MS = 2_000;

function prune(at: number): void {
  for (const [id, entry] of pushed) if (at - entry.at > FORGET_AFTER_MS) pushed.delete(id);
}

export function shouldPushApproval(sessionId: string): boolean {
  if (!isAgentEnabled()) return false;
  return sessionId === AGENT_SESSION_ID || loadPushSettings().approvalsForAllSessions;
}

interface PolicyApproval {
  requestId: string;
  code?: string;
  expiresAt?: number;
}

/**
 * The policy area owns approval codes and expiry; read them through its
 * public `GET /agent/approvals` contract instead of importing its module.
 * Absent or slow policy → the push goes out without a code.
 */
async function lookupPolicyApproval(requestId: string): Promise<PolicyApproval | null> {
  const match = matchRoute('GET', '/agent/approvals');
  if (!match || !('route' in match)) return null;
  const url = new URL('http://127.0.0.1/agent/approvals');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      Promise.resolve(match.route.handler(new Request(url), {}, url)),
      new Promise<null>(r => { timer = setTimeout(() => r(null), LOOKUP_TIMEOUT_MS); }),
    ]);
    if (!res || !res.ok) return null;
    const body = (await res.json()) as { approvals?: PolicyApproval[] };
    return body.approvals?.find(a => a?.requestId === requestId) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let lookupApproval = lookupPolicyApproval;

/** Tests only: stand in for the policy area without registering its route. */
export function _setApprovalLookupForTest(fn: ((requestId: string) => Promise<PolicyApproval | null>) | null): void {
  lookupApproval = fn ?? lookupPolicyApproval;
}

async function pushApprovalRequested(event: ApprovalRequestedEvent, entry: PushedApproval): Promise<boolean> {
  // The policy area assigns the code in its own listener; let every listener run first.
  await new Promise<void>(r => setTimeout(r, 0));
  const policy = await lookupApproval(event.requestId);
  if (entry.resolved) return false;
  const outcome = await pushToDevices({
    type: 'approval',
    requestId: event.requestId,
    code: typeof policy?.code === 'string' ? policy.code : null,
    title: event.title,
    summary: event.summary,
    toolName: event.toolName,
    sessionId: event.sessionId,
    sessionName: event.sessionName,
    expiresAt: typeof policy?.expiresAt === 'number' ? policy.expiresAt : null,
  });
  const failed = outcome.results.filter(r => !r.ok);
  if (failed.length && failed.length === outcome.results.length) {
    logError(`[push] Approval ${event.requestId} reached no phone: ${failed[0]!.error}`);
  }
  return outcome.results.some(r => r.ok);
}

export function handleApprovalRequested(event: ApprovalRequestedEvent): void {
  if (!shouldPushApproval(event.sessionId) || !canPush()) return;
  const at = Date.now();
  prune(at);
  const entry: PushedApproval = { at, sessionId: event.sessionId, sessionName: event.sessionName, resolved: false, sending: Promise.resolve(false) };
  entry.sending = pushApprovalRequested(event, entry).catch(err => {
    logError(`[push] approval push failed: ${err}`);
    return false;
  });
  pushed.set(event.requestId, entry);
}

export function handleApprovalResolved(event: ApprovalResolvedEvent): void {
  const entry = pushed.get(event.requestId);
  if (!entry) return;
  pushed.delete(event.requestId);
  entry.resolved = true;
  void entry.sending
    .then(async delivered => {
      if (!delivered) return;
      await pushToDevices({
        type: 'approval_resolved',
        requestId: event.requestId,
        allow: event.allow,
        via: event.via,
        sessionId: entry.sessionId,
        sessionName: entry.sessionName,
      });
    })
    .catch(err => logError(`[push] resolution push failed: ${err}`));
}

export function handleOwnerNotification(n: OwnerNotification): void {
  if (!isAgentEnabled() || !loadPushSettings().notifications || !canPush()) return;
  void pushToDevices({
    type: 'notify',
    title: n.title ?? null,
    text: n.text,
    priority: n.priority,
    sessionId: n.sessionId,
    sessionName: n.sessionName,
    quiet: n.quiet,
  }).catch(err => logError(`[push] notification push failed: ${err}`));
}

let installed = false;

export function installPushHooks(): void {
  if (installed) return;
  installed = true;
  onApproval({ onRequested: handleApprovalRequested, onResolved: handleApprovalResolved });
  onOwnerNotification(handleOwnerNotification);
}

/** Tests only. */
export function _pendingPushes(): Map<string, PushedApproval> {
  return pushed;
}
