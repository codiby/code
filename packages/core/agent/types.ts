/**
 * Codiby Agent — shared contracts.
 *
 * The agent is the always-on session `MAIN_SESSION_ID`. Everything that feeds
 * it (channels), shapes it (prompt sections, tools, policy) or reacts to it
 * (dispatch, approvals, push) plugs in through `registry.ts` using the types
 * below, so each area can live in its own folder without touching the others.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Session } from '../types';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelType = 'telegram' | 'whatsapp' | 'http_webhook' | 'ios_shortcut' | 'app';

/** A place a message came from or a reply goes to. */
export interface ChannelAddress {
  /** Configured channel instance id (one per bot / account / webhook). */
  channelId: string;
  channelType: ChannelType;
  /** Channel-native address: Telegram chat id, WhatsApp JID, webhook request id… */
  peer: string;
  peerName?: string;
  /** Channel-native id of the message being answered, for quoting/threading. */
  replyTo?: string;
}

export interface InboundAttachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  mime: string;
  /** Base64 payload. Images go to the model as-is; other kinds are saved to disk. */
  data?: string;
  /** Local path, when the adapter already saved the file. */
  path?: string;
  name?: string;
  /** Speech-to-text of an audio attachment, when the adapter transcribed it. */
  transcript?: string;
}

export interface InboundEnvelope extends ChannelAddress {
  /**
   * True only when the adapter verified the sender is the owner. Everything
   * else is stored as untrusted content and never reaches the agent as an
   * instruction.
   */
  trusted: boolean;
  text: string;
  attachments?: InboundAttachment[];
  /** Channel-native message id (dedup + read receipts). */
  externalId?: string;
  receivedAt?: number;
}

export type OutboundPriority = 'low' | 'normal' | 'urgent';

/** An approval request rendered on a channel (buttons, or a typed code). */
export interface ApprovalPrompt {
  requestId: string;
  /** Short code for channels without buttons: the owner replies "SI 4821" / "NO 4821". */
  code: string;
  title: string;
  summary: string;
  toolName: string;
  sessionId: string;
  sessionName: string;
  expiresAt: number;
}

export interface OutboundFile {
  path: string;
  name?: string;
  mime?: string;
  caption?: string;
}

export interface OutboundMessage {
  kind: 'text' | 'file' | 'approval' | 'voice';
  text: string;
  files?: OutboundFile[];
  approval?: ApprovalPrompt;
  priority?: OutboundPriority;
}

export interface ChannelCapabilities {
  images: boolean;
  files: boolean;
  voice: boolean;
  /** Can edit a sent message in place (working-message flow). */
  edits: boolean;
  /** Inline buttons (approve / deny). */
  buttons: boolean;
  typing: boolean;
  /** Max characters per message; the outbox splits longer text. */
  maxLength: number;
  /** Markup the outbox converts replies to before sending. */
  markup: 'markdown' | 'telegram-markdown' | 'whatsapp' | 'plain';
}

export interface ChannelStatus {
  connected: boolean;
  detail?: string;
  lastError?: string | null;
}

export interface SendResult {
  externalId?: string;
  /**
   * The platform may or may not have taken the message (a timeout or a
   * dropped connection after the request left). The adapter returns instead
   * of throwing so the outbox never retries it — a retry could deliver it
   * twice — and the delivery log records it as `unconfirmed`, not `sent`.
   */
  unconfirmed?: true;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly type: ChannelType;
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  /** The owner's address on this channel, for proactive messages. Null until paired. */
  ownerAddress(): ChannelAddress | null;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(to: ChannelAddress, msg: OutboundMessage): Promise<SendResult>;
  /** Show "typing…" while the agent works on a message from `to`. */
  typing?(to: ChannelAddress): Promise<void> | void;
  /** A turn that started from `to` ended without any text to deliver. */
  turnFinished?(to: ChannelAddress): Promise<void> | void;
  status(): ChannelStatus;
}

/** Where a user message in the agent's transcript came from (shown as a badge). */
export interface MessageSource {
  channelType: ChannelType;
  channelId: string;
  peerName?: string;
  trusted: boolean;
}

// ---------------------------------------------------------------------------
// Prompt, tools, routes
// ---------------------------------------------------------------------------

/** A block appended to the agent's system prompt (persona, profile, memory…). */
export interface PromptSection {
  id: string;
  /** Lower renders first. Persona is 0; areas use 10–90. */
  order: number;
  render(session: Session): string | null;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** 'agent' = only the agent session sees it; 'all' = every session. */
  scope: 'agent' | 'all';
}

export interface ToolContext {
  sessionId: string;
  sessionName: string;
}

export interface AgentToolGroup {
  id: string;
  tools(): AgentTool[];
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult>;
}

export type AgentRouteHandler = (
  req: Request,
  params: Record<string, string>,
  url: URL,
) => Promise<Response> | Response;

export interface AgentRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path under `/agent/…` with `:param` segments, e.g. `/agent/channels/:id/inbound`. */
  path: string;
  /**
   * Public routes skip the bridge's bearer-token check and MUST authenticate
   * the caller themselves (webhook secret, OAuth state…).
   */
  public?: boolean;
  /**
   * Owner changes and secrets: a caller trusted only for being on localhost
   * (curl, a script, the agent's own Bash) is refused; it takes the bearer
   * token or a page of the bridge's own UI (network/local-trust.ts).
   * Defaults to true for every non-public route that isn't GET; set it on a
   * GET that reveals a secret, or `false` for a mutation a local CLI must
   * still reach. Ignored on public routes.
   */
  sensitive?: boolean;
  handler: AgentRouteHandler;
}

/** How index.ts vouches for a request to `/agent/*` (see agent/routes.ts). */
export interface AgentRequestAuth {
  /** Passed the bridge's normal auth: localhost trust or the bearer token. */
  authenticated: boolean;
  /** The bearer token, or the bridge's own UI on this machine — what `sensitive` routes need. */
  ownerVerified: boolean;
}

// ---------------------------------------------------------------------------
// Policy and approvals
// ---------------------------------------------------------------------------

export type PolicyAction = 'allow' | 'ask' | 'deny';

export interface PolicyVerdict {
  action: PolicyAction;
  reason?: string;
  ruleId?: string;
  category?: string;
}

export interface PolicyRequest {
  session: Session;
  toolName: string;
  input: Record<string, unknown>;
  /**
   * 'preview' — the bridge only wants to label a tool card as auto-approved;
   *             must be side-effect free (no activity rows).
   * 'decide'  — a real permission decision; record it.
   */
  phase: 'preview' | 'decide';
  /** Provider request id, present in the 'decide' phase. */
  requestId?: string;
}

/** Returns null when the evaluator has no opinion (falls back to the permission mode). */
export type PolicyEvaluator = (req: PolicyRequest) => PolicyVerdict | null;

export interface ApprovalRequestedEvent {
  requestId: string;
  sessionId: string;
  sessionName: string;
  toolName: string;
  title: string;
  summary: string;
  input: Record<string, unknown>;
}

export interface ApprovalResolvedEvent {
  requestId: string;
  allow: boolean;
  /** Surface that answered: 'desktop', 'mobile', 'telegram', 'whatsapp', 'push', 'expired'… */
  via: string;
}

export interface ApprovalListener {
  onRequested?(event: ApprovalRequestedEvent): void;
  onResolved?(event: ApprovalResolvedEvent): void;
}

// ---------------------------------------------------------------------------
// Runtime dependencies wired from index.ts
// ---------------------------------------------------------------------------

export interface AgentDeps {
  port: number;
  sendMessage(
    sessionId: string,
    text: string,
    images?: { media_type: string; data: string }[],
    opts?: { source?: MessageSource },
  ): Promise<{ ok: boolean; error?: string }>;
  interruptSession(sessionId: string): Promise<void> | void;
  broadcastToSession(sessionId: string, msg: object): void;
  broadcastSessionList(): void;
}

export type { CallToolResult };
