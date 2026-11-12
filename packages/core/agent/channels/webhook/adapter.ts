/**
 * HTTP webhook and iOS Shortcut channels.
 *
 * Inbound: POST /agent/channels/:id/inbound with the channel token in
 * `X-Codiby-Token` or `Authorization: Bearer`. A valid token *is* the owner,
 * so these messages are trusted. Body: { text, images?, sender?, id? }.
 *
 * Replies:
 *  - native   — the request stays open until the agent answers that very
 *               request (each request is its own peer address), up to the
 *               channel's timeout; then 202 { queued } and the reply can be
 *               fetched from /replies/:requestId or arrives at the callback.
 *  - callback — 202 right away; replies are POSTed to callbackUrl, signed
 *               with HMAC-SHA256 over "<timestamp>.<body>".
 *  - none     — fire-and-forget.
 * ?format=text answers text/plain (what an iOS Shortcut wants to show).
 *
 * Retries: a caller that retries should send the same `id` (or an
 * `Idempotency-Key` header); without either, identical content within
 * RETRY_WINDOW_MS counts as the same message. Callback deliveries carry a
 * stable `deliveryId` (also in `X-Codiby-Delivery`) so a receiver can drop
 * our own retries of one reply.
 *
 * Callback targets (see checkCallbackUrl): the URL is only ever set through
 * owner-verified routes, so it is the owner's own choice and LAN / loopback
 * receivers (a local Home Assistant, n8n…) are allowed. Refused, both when it
 * is saved and again before every POST: non-http(s) schemes, credentials in
 * the URL, link-local addresses, and this bridge itself on loopback (its API
 * trusts localhost callers). Redirects are never followed, so a receiver
 * can't bounce the signed body somewhere else.
 */

import { createHash, createHmac, randomUUID } from 'crypto';
import { PORT } from '../../../config/config';
import { log } from '../../../lib/logger';
import { safeEqual } from '../../http';
import { deliverInbound } from '../../inbound';
import { agentDeps, hasAgentDeps } from '../../runtime';
import { approvalBody, approvalSettlement, lateApprovalNotice, parseApprovalReply } from '../approvals';
import { parseCommand } from '../commands';
import { DeliveryUncertainError, RetryWindow, errorText, failedBeforeSending, isDeliveryUncertain, logUncertain } from '../delivery';
import type {
  ApprovalPrompt,
  ChannelAdapter,
  ChannelAddress,
  ChannelCapabilities,
  ChannelStatus,
  InboundAttachment,
  OutboundMessage,
  SendResult,
} from '../../types';
import type { WebhookChannelConfig } from '../config';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebhookDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** Pieces of one reply arriving within this window are joined (dispatch sends texts one by one). */
  collectMs?: number;
}

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const LATE_TTL_MS = 30 * 60_000;
export const CALLBACK_TIMEOUT_MS = 15_000;
const MAX_LATE = 50;
/**
 * Identical bodies without an id inside this window are one message retried
 * (a client that timed out waiting for a native reply and sent it again).
 * Short, because a person repeating themselves on purpose must still get through.
 */
export const RETRY_WINDOW_MS = 2 * 60_000;
const IDEMPOTENCY_HEADERS = ['idempotency-key', 'x-idempotency-key'];

export class WebhookRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface WebhookBody {
  text: string;
  images: { media_type: string; data: string }[];
  sender: string | null;
  id: string | null;
}

/** Validate a webhook body; throws WebhookRequestError(400) with a human message. */
export function parseWebhookBody(raw: unknown): WebhookBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WebhookRequestError(400, 'Body must be a JSON object');
  const b = raw as Record<string, unknown>;
  if (b.text !== undefined && typeof b.text !== 'string') throw new WebhookRequestError(400, '"text" must be a string');
  const text = ((b.text as string | undefined) ?? '').slice(0, 20_000);
  const images: WebhookBody['images'] = [];
  if (b.images !== undefined) {
    if (!Array.isArray(b.images)) throw new WebhookRequestError(400, '"images" must be an array');
    if (b.images.length > MAX_IMAGES) throw new WebhookRequestError(400, `At most ${MAX_IMAGES} images`);
    for (const img of b.images) {
      const i = (img ?? {}) as Record<string, unknown>;
      const type = typeof i.media_type === 'string' ? i.media_type.toLowerCase() : '';
      const data = typeof i.data === 'string' ? i.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '') : '';
      if (!IMAGE_TYPES.has(type)) throw new WebhookRequestError(400, 'images[].media_type must be image/png, image/jpeg, image/gif or image/webp');
      if (!data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new WebhookRequestError(400, 'images[].data must be base64 (max ~7 MB)');
      images.push({ media_type: type, data });
    }
  }
  if (!text.trim() && images.length === 0) throw new WebhookRequestError(400, 'Send "text" or "images"');
  const sender = typeof b.sender === 'string' && b.sender.trim() ? b.sender.trim().slice(0, 100) : null;
  const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim().slice(0, 200) : null;
  return { text, images, sender, id };
}

/** Candidate tokens a caller may present. The legacy header keeps migrated callers working. */
export function presentedTokens(req: Request): string[] {
  const out: string[] = [];
  const h = req.headers;
  const direct = h.get('x-codiby-token');
  if (direct) out.push(direct.trim());
  const auth = h.get('authorization');
  const bearer = auth && /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1];
  if (bearer) out.push(bearer.trim());
  const legacy = h.get('x-personal-agent-token');
  if (legacy) out.push(legacy.trim());
  return out;
}

export function signCallback(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Loopback as the URL parser leaves it (it already folds `127.1`, `0x7f.0.0.1`, `[0:…:1]`). */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0') return true;
  return h === '[::1]' || h === '[::]' || h.startsWith('[::ffff:127.') || h.startsWith('[::ffff:7f');
}

function isLinkLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return /^169\.254\.\d+\.\d+$/.test(h) || /^\[fe[89ab][0-9a-f]:/.test(h) || h.startsWith('[::ffff:a9fe:');
}

function currentBridgePort(): number {
  return hasAgentDeps() ? agentDeps().port : PORT;
}

/**
 * Validate a callback URL (see the header). Throws an Error with a reason
 * fit for the owner; returns the parsed URL otherwise. Hostnames are not
 * resolved: the URL is the owner's choice, this guards against mistakes and
 * against configs that never went through the routes (migrated, hand-edited).
 */
export function checkCallbackUrl(raw: string, bridgePort = currentBridgePort()): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('The callback URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The callback URL must be http(s)');
  if (u.username || u.password) throw new Error('The callback URL must not carry a username or password');
  if (isLinkLocalHost(u.hostname)) throw new Error('The callback URL points at a link-local address');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (isLoopbackHost(u.hostname) && port === bridgePort) {
    throw new Error('The callback URL points at this bridge itself');
  }
  return u;
}

interface Pending {
  texts: string[];
  resolve: (texts: string[] | null) => void;
  flush: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

interface Late {
  texts: string[];
  at: number;
}

export class WebhookChannel implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities;
  private running = false;
  private readonly pending = new Map<string, Pending>();
  private readonly late = new Map<string, Late>();
  private readonly retries = new RetryWindow(RETRY_WINDOW_MS);
  /** One id per outbound message, reused by the outbox's retries of it. */
  private readonly deliveryIds = new WeakMap<OutboundMessage, string>();
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(
    private cfg: WebhookChannelConfig,
    private readonly deps: WebhookDeps,
    private readonly secrets: { token: () => string | null; signing: () => string | null },
  ) {
    this.now = deps.now ?? Date.now;
    this.capabilities = {
      images: false, files: false, voice: false, edits: false, buttons: false, typing: false,
      maxLength: 20_000,
      // A Shortcut shows raw text; a generic webhook gets the agent's Markdown.
      markup: cfg.type === 'ios_shortcut' ? 'plain' : 'markdown',
    };
  }

  get id(): string { return this.cfg.id; }
  get name(): string { return this.cfg.name; }
  get type(): WebhookChannelConfig['type'] { return this.cfg.type; }
  get config(): WebhookChannelConfig { return this.cfg; }

  start(): void { this.running = true; }

  stop(): void {
    this.running = false;
    for (const [id, p] of this.pending) this.settle(id, p, null);
  }

  status(): ChannelStatus {
    const hasToken = !!this.secrets.token();
    const detail = this.cfg.reply === 'native'
      ? 'Replies in the HTTP response'
      : this.cfg.reply === 'callback'
        ? (this.cfg.callbackUrl ? `Replies POSTed to ${safeHost(this.cfg.callbackUrl)}` : 'Callback URL missing')
        : 'No replies';
    return { connected: this.running && hasToken, detail, lastError: hasToken ? this.lastError : 'No token' };
  }

  /** Proactive messages need somewhere to go: only channels with a callback URL can take them. */
  ownerAddress(): ChannelAddress | null {
    if (!this.cfg.callbackUrl) return null;
    return { channelId: this.id, channelType: this.type, peer: 'owner' };
  }

  authenticate(req: Request): boolean {
    const secret = this.secrets.token();
    if (!secret) return false;
    return presentedTokens(req).some(t => safeEqual(t, secret));
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  async handleRequest(req: Request, url: URL): Promise<Response> {
    const asText = url.searchParams.get('format') === 'text';
    const length = Number(req.headers.get('content-length') || 0);
    if (length > MAX_BODY_BYTES) throw new WebhookRequestError(413, 'Body too large');
    let raw: unknown;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) throw new WebhookRequestError(413, 'Body too large');
      raw = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      if (err instanceof WebhookRequestError) throw err;
      throw new WebhookRequestError(400, 'Body must be JSON');
    }
    const body = parseWebhookBody(raw);
    const externalId = this.inboundId(req, body);
    const requestId = `req_${randomUUID()}`;
    const native = this.cfg.reply === 'native';
    const waiter = native ? this.openPending(requestId, this.cfg.replyTimeoutSec * 1000) : null;

    const attachments: InboundAttachment[] = body.images.map(i => ({ kind: 'image', mime: i.media_type, data: i.data }));
    const result = await deliverInbound({
      channelId: this.id,
      channelType: this.type,
      peer: requestId,
      peerName: body.sender ?? undefined,
      trusted: true,
      text: body.text,
      attachments: attachments.length ? attachments : undefined,
      externalId,
      receivedAt: this.now(),
    });

    if (!result.ok || result.outcome === 'duplicate') {
      const p = this.pending.get(requestId);
      if (p) this.settle(requestId, p, null, false);
      if (!result.ok) return respond(asText, 503, { error: result.error || 'The agent is not reachable' }, result.error || 'The agent is not reachable');
      return respond(asText, 200, { ok: true, duplicate: true }, '');
    }
    if (!waiter) return respond(asText, 202, { ok: true, accepted: true, requestId }, 'Sent.');
    if (result.outcome === 'consumed') {
      // A command or approval code: its reply (if any) was sent before deliverInbound returned.
      const p = this.pending.get(requestId);
      if (p && p.texts.length === 0) this.settle(requestId, p, [], false);
    }

    const texts = await waiter;
    if (texts === null) {
      return respond(asText, 202, {
        ok: true,
        queued: true,
        requestId,
        pollUrl: `/agent/channels/${encodeURIComponent(this.id)}/replies/${requestId}`,
      }, 'Still working on it — the answer will arrive later.');
    }
    const reply = texts.join('\n\n');
    return respond(asText, 200, { ok: true, requestId, reply }, reply);
  }

  /**
   * The id inbound dedupes on: the caller's own `id`, else its idempotency
   * header, else one derived from the content (see RETRY_WINDOW_MS).
   * Commands and approval answers get none: "/status" twice in a row is two
   * questions, and running one of them twice is harmless.
   */
  inboundId(req: Request, body: WebhookBody): string | undefined {
    if (body.id) return body.id;
    for (const h of IDEMPOTENCY_HEADERS) {
      const v = req.headers.get(h)?.trim();
      if (v) return `idem:${v.slice(0, 200)}`;
    }
    if (body.images.length === 0 && (parseCommand(body.text) || parseApprovalReply(body.text))) return undefined;
    const images = body.images.map(i => createHash('sha256').update(i.data).digest('hex').slice(0, 16)).join(',');
    return this.retries.idFor([this.id, body.sender, body.text, images], this.now());
  }

  private openPending(requestId: string, timeoutMs: number): Promise<string[] | null> {
    return new Promise(resolve => {
      const entry: Pending = { texts: [], resolve, flush: null, done: false };
      this.pending.set(requestId, entry);
      const timer = setTimeout(() => {
        if (entry.done) return;
        // Too slow for this request: whatever comes later is kept for polling / the callback.
        this.settle(requestId, entry, null);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  private settle(requestId: string, entry: Pending, texts: string[] | null, keepLate = true): void {
    if (entry.done) return;
    entry.done = true;
    if (entry.flush) clearTimeout(entry.flush);
    this.pending.delete(requestId);
    if (texts === null && keepLate) this.rememberLate(requestId, entry.texts);
    entry.resolve(texts);
  }

  private rememberLate(requestId: string, texts: string[]): void {
    const cutoff = this.now() - LATE_TTL_MS;
    for (const [id, l] of this.late) if (l.at < cutoff) this.late.delete(id);
    while (this.late.size >= MAX_LATE) {
      const oldest = this.late.keys().next().value;
      if (!oldest) break;
      this.late.delete(oldest);
    }
    this.late.set(requestId, { texts: [...texts], at: this.now() });
  }

  /** Late reply for a request that timed out: null = unknown request. */
  lateReply(requestId: string): { ready: boolean; reply: string } | null {
    if (this.pending.has(requestId)) return { ready: false, reply: '' };
    const late = this.late.get(requestId);
    if (!late) return null;
    return { ready: late.texts.length > 0, reply: late.texts.join('\n\n') };
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  async send(to: ChannelAddress, msg: OutboundMessage): Promise<SendResult> {
    let text = msg.text;
    if (msg.kind === 'approval' && msg.approval) {
      // Answered while the fan-out or the outbox's retry backoff held this
      // send: the receiver would be asked about something already decided.
      if (approvalSettlement(msg.approval.requestId)) {
        log(`[webhook] ${this.name}: approval ${msg.approval.code} was answered before it went out — not sent`);
        return {};
      }
      if (!text.trim()) text = approvalBody(msg.approval);
      const { code } = msg.approval;
      if (!text.includes(code)) text = `${text}\n\nReply "SI ${code}" to approve or "NO ${code}" to deny.`;
    }
    const pending = this.pending.get(to.peer);
    if (pending && !pending.done) {
      pending.texts.push(text);
      if (pending.flush) clearTimeout(pending.flush);
      pending.flush = setTimeout(() => this.settle(to.peer, pending, pending.texts), this.deps.collectMs ?? 300);
      return { externalId: to.peer };
    }
    if (this.cfg.callbackUrl) {
      let unconfirmed = false;
      try {
        await this.postCallback(to.peer, msg, text);
      } catch (err) {
        if (!isDeliveryUncertain(err)) throw err;
        // The receiver may have it already; a retry would hand it the reply twice.
        logUncertain('webhook', `${this.name}: a ${msg.kind} callback`, err);
        unconfirmed = true;
      }
      if (msg.kind === 'approval' && msg.approval) await this.settleLateApproval(to.peer, msg.approval);
      return unconfirmed ? { unconfirmed: true } : {};
    }
    const late = this.late.get(to.peer);
    if (late) {
      late.texts.push(text);
      late.at = this.now();
      return { externalId: to.peer };
    }
    throw new Error('This webhook channel has no open request to answer and no callback URL');
  }

  /**
   * The approval callback went out while the owner answered elsewhere: a
   * follow-up callback says it is already decided. Best effort, and never
   * thrown on — the approval callback itself was delivered.
   */
  private async settleLateApproval(peer: string, approval: ApprovalPrompt): Promise<void> {
    const answered = approvalSettlement(approval.requestId);
    if (!answered) return;
    const text = lateApprovalNotice(approval, answered, this.type);
    try {
      await this.postCallback(peer, { kind: 'text', text, priority: 'normal' }, text);
    } catch (err) {
      log(`[webhook] ${this.name}: could not say approval ${approval.code} was already answered: ${errorText(err)}`);
    }
  }

  turnFinished(to: ChannelAddress): void {
    const pending = this.pending.get(to.peer);
    if (pending) this.settle(to.peer, pending, pending.texts);
  }

  private deliveryId(msg: OutboundMessage): string {
    let id = this.deliveryIds.get(msg);
    if (!id) {
      id = `dlv_${randomUUID()}`;
      this.deliveryIds.set(msg, id);
    }
    return id;
  }

  /**
   * Throws a plain Error when the receiver definitely didn't take the reply
   * (unreachable, or it answered non-2xx: retry), DeliveryUncertainError
   * when the request went out but no answer came back (don't retry).
   */
  private async postCallback(peer: string, msg: OutboundMessage, text: string): Promise<void> {
    const signing = this.secrets.signing();
    if (!signing) throw new Error('Missing signing secret');
    try {
      checkCallbackUrl(this.cfg.callbackUrl);
    } catch (err) {
      this.lastError = `Callback refused: ${errorText(err)}`;
      throw new Error(this.lastError);
    }
    const deliveryId = this.deliveryId(msg);
    const body = JSON.stringify({
      deliveryId,
      channelId: this.id,
      requestId: peer === 'owner' ? null : peer,
      kind: msg.kind,
      text,
      priority: msg.priority ?? 'normal',
      ...(msg.approval ? {
        approval: {
          requestId: msg.approval.requestId,
          code: msg.approval.code,
          title: msg.approval.title,
          summary: msg.approval.summary,
          toolName: msg.approval.toolName,
          sessionName: msg.approval.sessionName,
          // 0 = never expires; null keeps receivers from rendering it as 1970.
          expiresAt: msg.approval.expiresAt > 0 ? msg.approval.expiresAt : null,
        },
      } : {}),
      sentAt: this.now(),
    });
    const timestamp = String(Math.floor(this.now() / 1000));
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(this.cfg.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Codiby-Agent',
          'X-Codiby-Delivery': deliveryId,
          'X-Codiby-Timestamp': timestamp,
          'X-Codiby-Signature': signCallback(signing, timestamp, body),
        },
        body,
        // A 307/308 would resend the signed body to wherever the receiver points.
        redirect: 'manual',
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
    } catch (err) {
      if (failedBeforeSending(err)) {
        this.lastError = `Callback failed: ${errorText(err)}`;
        throw new Error(this.lastError);
      }
      this.lastError = `Callback unconfirmed: ${errorText(err)}`;
      throw new DeliveryUncertainError(this.lastError);
    }
    if (!res.ok) {
      const redirected = res.status >= 300 && res.status < 400;
      this.lastError = `Callback returned ${res.status}${redirected ? ' (redirects are not followed)' : ''}`;
      throw new Error(this.lastError);
    }
    this.lastError = null;
    log(`[webhook] ${this.name}: reply delivered to callback`);
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return 'the callback URL'; }
}

function respond(asText: boolean, status: number, json: Record<string, unknown>, text: string): Response {
  if (asText) return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return Response.json(json, { status });
}
