/**
 * WhatsApp channel over the wacli CLI.
 *
 * Inbound: the wacli backend POSTs `message.received` to
 * /agent/channels/:id/inbound with an `x-codiby-token` header the channel
 * registers itself (idempotently) on start. Only a direct chat from one of
 * owner.whatsappJids reaches the agent; other people's messages are kept in
 * the untrusted inbox (direct chats by default, groups only when enabled).
 *
 * Outbound: `wacli text` / `wacli media` via argv, no shell. No buttons, so
 * approvals are text with a code the owner answers ("SI 4821").
 */

import { log, logError } from '../../../lib/logger';
import { PORT } from '../../../config/config';
import { safeEqual } from '../../http';
import { loadAgentConfig } from '../../config';
import { deliverInbound, type InboundResult } from '../../inbound';
import { agentDeps, hasAgentDeps } from '../../runtime';
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
import { approvalBody, approvalSettlement, lateApprovalNotice } from '../approvals';
import type { WhatsAppChannelConfig } from '../config';
import { logUncertain, partTracker } from '../delivery';
import { cliError, mediaTypeFor, parseWacliStatus, parseWebhookList, sendOutcome, wacliArgv, type CliRunner, type WacliTarget } from './cli';
import { downloadWacliMedia, readWacliBackend, type WacliBackend } from './media';
import {
  isMediaType,
  isOwnerMessage,
  isVoiceType,
  jidVariants,
  mapLid,
  mediaPlaceholder,
  normalizeJid,
  parseWacliPayload,
  type WhatsAppMessage,
} from './payload';

const STATUS_TTL_MS = 60_000;
const INLINE_IMAGE_LIMIT = 5 * 1024 * 1024;
const RECENT_IDS = 500;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WhatsAppDeps {
  run: CliRunner;
  /** Fetch used for media downloads from the wacli backend. */
  fetch?: FetchLike;
  transcribe(audio: Uint8Array): Promise<string>;
  /** Backend credentials for media; null = media is not downloadable. */
  backend?: () => WacliBackend | null;
  /** Skip webhook registration and status probes on start (tests). */
  autoRegister?: boolean;
}

export type WebhookRegistration = { action: 'unchanged' | 'added' | 'updated'; url: string };

export type PayloadOutcome =
  | { handled: false; reason: string }
  | { handled: true; result: InboundResult; trusted: boolean };

export class WhatsAppChannel implements ChannelAdapter {
  readonly type = 'whatsapp' as const;
  readonly capabilities: ChannelCapabilities = {
    images: true, files: true, voice: true, edits: false, buttons: false, typing: false,
    maxLength: 3500, markup: 'whatsapp',
  };

  private running = false;
  private state: string | null = null;
  private user: string | null = null;
  private lastError: string | null = null;
  private statusAt = 0;
  private statusPending: Promise<void> | null = null;
  private readonly recentIds: string[] = [];
  private readonly fileProgress = partTracker();

  constructor(
    private cfg: WhatsAppChannelConfig,
    private readonly deps: WhatsAppDeps,
    /** Inbound token (vault); null until generated. */
    private readonly secret: () => string | null,
  ) {}

  get id(): string { return this.cfg.id; }
  get name(): string { return this.cfg.name; }
  get config(): WhatsAppChannelConfig { return this.cfg; }

  private get target(): WacliTarget {
    return { binary: this.cfg.binary, account: this.cfg.account };
  }

  inboundUrl(): string {
    const port = hasAgentDeps() ? agentDeps().port : PORT;
    const baseUrl = this.cfg.inboundBaseUrl || `http://127.0.0.1:${port}`;
    return `${baseUrl}/agent/channels/${encodeURIComponent(this.cfg.id)}/inbound`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle + status
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    if (this.deps.autoRegister === false) return;
    await this.refreshStatus();
    try {
      const reg = await this.registerWebhook();
      if (reg.action !== 'unchanged') log(`[whatsapp] ${this.name}: webhook ${reg.action} → ${reg.url}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logError(`[whatsapp] ${this.name}: webhook registration failed: ${this.lastError}`);
    }
  }

  stop(): void {
    this.running = false;
  }

  async refreshStatus(): Promise<{ state: string | null; user: string | null }> {
    const res = await this.deps.run(wacliArgv.status(this.target), { timeoutMs: 15_000 });
    this.statusAt = Date.now();
    if (res.code !== 0) {
      this.state = null;
      this.lastError = cliError(res, 'wacli status').message;
      return { state: null, user: null };
    }
    const parsed = parseWacliStatus(res.stdout);
    this.state = parsed.state;
    this.user = parsed.user;
    if (this.lastError?.startsWith('wacli status')) this.lastError = null;
    return parsed;
  }

  status(): ChannelStatus {
    // Status is a CLI round trip: serve the cached value, refresh in the background.
    if (this.running && this.deps.autoRegister !== false && Date.now() - this.statusAt > STATUS_TTL_MS && !this.statusPending) {
      this.statusPending = this.refreshStatus().then(() => {}, () => {}).finally(() => { this.statusPending = null; });
    }
    const owners = loadAgentConfig().owner.whatsappJids.length;
    const account = this.cfg.account || 'default account';
    const detail = `${account} · ${this.state ?? 'unknown'}${owners ? '' : ' · no owner number set'}`;
    return { connected: this.running && this.state === 'open', detail, lastError: this.lastError };
  }

  ownerAddress(): ChannelAddress | null {
    const { owner } = loadAgentConfig();
    const jid = owner.whatsappJids.map(normalizeJid).find(Boolean);
    if (!jid) return null;
    return { channelId: this.id, channelType: 'whatsapp', peer: jid, peerName: owner.name || undefined };
  }

  // -------------------------------------------------------------------------
  // Webhook registration
  // -------------------------------------------------------------------------

  /**
   * Make sure wacli posts message.received to this channel with the current
   * token: unchanged when exactly one matching hook exists, replaced when the
   * URL matches but the token or account filter is stale.
   */
  async registerWebhook(): Promise<WebhookRegistration> {
    const secret = this.secret();
    if (!secret) throw new Error('The channel has no inbound token yet');
    const url = this.inboundUrl();
    const ls = await this.deps.run(wacliArgv.webhookList(this.target), { timeoutMs: 15_000 });
    if (ls.code !== 0) throw cliError(ls, 'wacli webhook ls');
    const hooks = parseWebhookList(ls.stdout);
    const indexes = hooks.map((h, i) => (h.url === url ? i : -1)).filter(i => i >= 0);
    const tokenOf = (h: (typeof hooks)[number]) => {
      const entry = Object.entries(h.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-codiby-token');
      return entry ? entry[1] : '';
    };
    const accountOk = (h: (typeof hooks)[number]) => {
      const accounts = h.when?.account ?? [];
      return this.cfg.account ? accounts.length === 1 && accounts[0] === this.cfg.account : accounts.length === 0;
    };
    if (indexes.length === 1) {
      const hook = hooks[indexes[0]!]!;
      if (safeEqual(tokenOf(hook), secret) && accountOk(hook) && !hook.when?.from?.length) return { action: 'unchanged', url };
    }
    // Highest index first so earlier indexes stay valid while removing.
    for (const i of [...indexes].reverse()) {
      const rm = await this.deps.run(wacliArgv.webhookRemoveIndex(this.target, i), { timeoutMs: 15_000 });
      if (rm.code !== 0) throw cliError(rm, 'wacli webhook rm');
    }
    const add = await this.deps.run(wacliArgv.webhookAdd(this.target, url, `x-codiby-token: ${secret}`), { timeoutMs: 15_000 });
    if (add.code !== 0) throw cliError(add, 'wacli webhook add');
    if (this.lastError?.startsWith('wacli webhook')) this.lastError = null;
    return { action: indexes.length ? 'updated' : 'added', url };
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  authenticate(req: Request): boolean {
    const secret = this.secret();
    const got = req.headers.get('x-codiby-token') ?? '';
    return !!secret && safeEqual(got, secret);
  }

  private seen(id: string): boolean {
    if (this.recentIds.includes(id)) return true;
    this.recentIds.push(id);
    if (this.recentIds.length > RECENT_IDS) this.recentIds.shift();
    return false;
  }

  isOwner(msg: WhatsAppMessage): boolean {
    return isOwnerMessage(msg, loadAgentConfig().owner.whatsappJids, this.cfg.lidMap);
  }

  async handlePayload(raw: unknown): Promise<PayloadOutcome> {
    const msg = parseWacliPayload(raw, this.cfg.lidMap);
    if (!msg) return { handled: false, reason: 'not a received message' };
    if (msg.test) return { handled: false, reason: 'test payload' };
    if (msg.fromMe) return { handled: false, reason: 'sent by this account' };
    if (this.cfg.account && msg.account && msg.account !== this.cfg.account) return { handled: false, reason: 'another account' };
    if (msg.type === 'reaction' || msg.type === 'protocol') return { handled: false, reason: `${msg.type} ignored` };
    if (this.seen(`${msg.chat}:${msg.id}`)) return { handled: false, reason: 'duplicate' };

    const trusted = this.isOwner(msg);
    if (!trusted) {
      const keep = msg.isGroup ? this.cfg.storeGroups : this.cfg.storeDirect;
      if (!keep) return { handled: false, reason: msg.isGroup ? 'group messages are not kept' : 'messages from others are not kept' };
    }

    const lines: string[] = [];
    if (msg.text.trim()) lines.push(msg.text.trim());
    const attachments: InboundAttachment[] = [];
    if (isMediaType(msg.type)) {
      // Other people's media is never fetched: it is untrusted and nobody asked for it.
      if (!trusted) lines.push(mediaPlaceholder(msg.type, 'not-downloaded'));
      else await this.collectMedia(msg, lines, attachments);
    }
    if (lines.length === 0 && attachments.length === 0) lines.push(`(${msg.type} message)`);

    const senderName = msg.pushName || jidVariants(msg.from)[0]?.split('@')[0] || msg.from;
    const result = await deliverInbound({
      channelId: this.id,
      channelType: 'whatsapp',
      peer: msg.replyJid,
      peerName: msg.isGroup ? `${senderName} (group ${msg.chat.split('@')[0]})` : senderName,
      trusted,
      text: lines.join('\n'),
      attachments: attachments.length ? attachments : undefined,
      externalId: msg.id,
      replyTo: msg.id,
      receivedAt: msg.at,
    });

    const markRead = this.cfg.markRead === 'all' || (this.cfg.markRead === 'owner' && trusted);
    if (markRead && result.ok) void this.markRead(msg);
    return { handled: true, result, trusted };
  }

  private async collectMedia(msg: WhatsAppMessage, lines: string[], attachments: InboundAttachment[]): Promise<void> {
    const backend = this.cfg.downloadMedia ? (this.deps.backend ?? (() => readWacliBackend(this.cfg.wacliConfigPath)))() : null;
    if (!backend) {
      lines.push(mediaPlaceholder(msg.type, 'not-downloadable'));
      return;
    }
    const res = await downloadWacliMedia(backend, { jid: msg.chat, id: msg.id, account: msg.account ?? (this.cfg.account || null) }, { fetch: this.deps.fetch });
    if (!res.ok) {
      lines.push(`${mediaPlaceholder(msg.type, 'not-downloadable')} — ${res.reason}`);
      return;
    }
    const mime = res.mime !== 'application/octet-stream' ? res.mime : msg.mime || res.mime;
    const data = Buffer.from(res.data).toString('base64');
    if (msg.type === 'image' && res.data.byteLength <= INLINE_IMAGE_LIMIT && /^image\/(png|jpe?g|gif|webp)$/i.test(mime)) {
      attachments.push({ kind: 'image', mime, data });
      return;
    }
    if (isVoiceType(msg.type, mime)) {
      let transcript = '';
      try {
        transcript = (await this.deps.transcribe(res.data)).trim();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        lines.push(`(Voice note — not transcribed: ${/api key/i.test(reason) ? 'no Deepgram API key configured' : reason})`);
      }
      attachments.push({ kind: 'audio', mime, data, ...(transcript ? { transcript } : {}) });
      return;
    }
    attachments.push({ kind: msg.type === 'video' ? 'video' : msg.type === 'image' ? 'image' : 'file', mime, data });
  }

  private async markRead(msg: WhatsAppMessage): Promise<void> {
    const res = await this.deps.run(wacliArgv.read(this.target, msg.chat, msg.id, msg.isGroup ? msg.from : undefined), { timeoutMs: 15_000 });
    if (res.code !== 0) log(`[whatsapp] ${this.name}: mark read failed: ${cliError(res, 'wacli read').message}`);
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** `wacli text` can't deliver to a LID; send to the mapped phone JID. */
  private deliverable(peer: string): string {
    return mapLid(peer, this.cfg.lidMap) || peer;
  }

  /**
   * Throws only when wacli definitely did not send (the outbox retries
   * those). A run that was killed or timed out waiting for WhatsApp's ack
   * may have delivered: it is logged and counted as sent, never retried.
   */
  async send(to: ChannelAddress, msg: OutboundMessage): Promise<SendResult> {
    const jid = this.deliverable(to.peer);
    if ((msg.kind === 'file' || msg.kind === 'voice') && msg.files?.length) {
      // A retry resumes after the files that already went out.
      const progress = this.fileProgress(msg);
      for (let i = progress.done; i < msg.files.length; i++) {
        const f = msg.files[i]!;
        const caption = f.caption ?? (i === 0 ? msg.text.trim() || undefined : undefined);
        const argv = wacliArgv.media(this.target, jid, f.path, { caption, type: mediaTypeFor(f.mime, msg.kind === 'voice') });
        const res = await this.deps.run(argv, { timeoutMs: 120_000 });
        const outcome = sendOutcome(res);
        if (outcome === 'failed') throw cliError(res, 'wacli media');
        if (outcome === 'uncertain') {
          logUncertain('whatsapp', `${this.name}: file ${i + 1} of ${msg.files.length} to ${jid}`, cliError(res, 'wacli media'));
          progress.unconfirmed = true;
        }
        progress.firstId ??= messageIdFrom(res.stdout);
        progress.done = i + 1;
      }
      return { externalId: progress.firstId, ...(progress.unconfirmed ? { unconfirmed: true } : {}) };
    }
    let text = msg.text;
    if (msg.kind === 'approval' && msg.approval) {
      // Answered while the fan-out or the outbox's retry backoff held this
      // send: a "Reply SI …" for a decided request would only confuse.
      if (approvalSettlement(msg.approval.requestId)) {
        log(`[whatsapp] ${this.name}: approval ${msg.approval.code} was answered before it went out — not sent`);
        return {};
      }
      const { code } = msg.approval;
      if (!text.trim()) text = approvalBody(msg.approval);
      if (!text.includes(code)) {
        text = `${text.trim()}\n\nReply "SI ${code}" to approve or "NO ${code}" to deny.`.trim();
      }
    }
    const res = await this.deps.run(wacliArgv.text(this.target, jid, text), { timeoutMs: 30_000 });
    const outcome = sendOutcome(res);
    if (outcome === 'failed') throw cliError(res, 'wacli text');
    if (msg.kind === 'approval' && msg.approval) await this.settleLateApproval(jid, msg.approval);
    if (outcome === 'uncertain') {
      logUncertain('whatsapp', `${this.name}: a ${msg.kind} message to ${jid}`, cliError(res, 'wacli text'));
      return { unconfirmed: true };
    }
    return { externalId: messageIdFrom(res.stdout) };
  }

  /**
   * The prompt went out while the owner answered elsewhere. WhatsApp can't
   * edit it, so a short note follows saying it is already decided. Best
   * effort: the answer stands either way.
   */
  private async settleLateApproval(jid: string, approval: ApprovalPrompt): Promise<void> {
    const answered = approvalSettlement(approval.requestId);
    if (!answered) return;
    try {
      const res = await this.deps.run(wacliArgv.text(this.target, jid, lateApprovalNotice(approval, answered, 'whatsapp')), { timeoutMs: 30_000 });
      if (sendOutcome(res) === 'failed') throw cliError(res, 'wacli text');
    } catch (err) {
      // Never thrown on: the prompt itself went out, and a retry would post it again.
      log(`[whatsapp] ${this.name}: could not say approval ${approval.code} was already answered: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function messageIdFrom(stdout: string): string | undefined {
  return /\bid[:=]\s*([A-Za-z0-9]{8,})/i.exec(stdout)?.[1];
}
