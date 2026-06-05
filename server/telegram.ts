import { Telegraf } from 'telegraf';
import { randomUUID } from 'crypto';
import { log, logError } from './logger';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MAIN_SESSION_ID, CWD } from './config';
import { sessions, saveSessions } from './sessions';
import { startProviderSession } from './provider/lifecycle';
import { DEFAULT_PROVIDER } from './provider/registry';
import { resolvePermissionDecision } from './provider/bridge';
import { getSessionState, addMessage, updateSessionState, type ChatMessage } from './state';
import { loadTelegramSettings } from './storage';
import { transcribeAudioFromUrl } from './deepgram';
import type { Session } from './types';

let bot: Telegraf | null = null;
let currentChatIdSetting: string = '';
let activeChatId: string | number | null = null;
let currentPort = 0;
let lastNotifiedMessageId: string | null = null;

// When the user sends a message from Telegram we immediately post a
// "⏳ Claude is working…" acknowledgement so they KNOW the bot received it
// and is still connected (the Telegraf long-poll session occasionally drops
// silently and this is the only way to tell from the user's side). The
// message id is kept here so that, when Claude's first reply lands, we
// EDIT that same message in place instead of posting a fresh bubble —
// preserving the 1-user-message → 1-reply visual pairing.
let pendingWorkingMessage: { chatId: string | number; messageId: number } | null = null;
// Last rendered working-message text and its edit timestamp. Used by
// updateWorkingWithTool() to avoid "message is not modified" errors and to
// throttle rapid tool-use sequences under Telegram's edit rate limit
// (≈ 1 edit/sec per chat before 429s).
let lastWorkingMessageText = '';
let lastWorkingEditAt = 0;
const WORKING_EDIT_THROTTLE_MS = 1500;

// State for self-healing the long-poll loop. When Telegraf's getUpdates
// loop dies (most commonly from a 409 Conflict — another instance is also
// polling this bot token), we tear the dead instance down, build a fresh
// one, and re-launch with backoff. Without this the bot looks alive
// (`bot !== null`) but silently stops receiving messages.
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

type Broadcaster = (sessionId: string, msg: object) => void;
let broadcastToSession: Broadcaster = () => {};
export function setTelegramBroadcaster(fn: Broadcaster) { broadcastToSession = fn; }

function resolveSettings(): { botToken: string; chatId: string } {
  const stored = loadTelegramSettings();
  return {
    botToken: stored.botToken || TELEGRAM_BOT_TOKEN,
    chatId: stored.chatId || TELEGRAM_CHAT_ID,
  };
}

/**
 * Convert CommonMark-ish markdown into Telegram's legacy Markdown flavor.
 * Mainly: `**bold**` → `*bold*`. Code spans/blocks are left untouched.
 */
function toTelegramMarkdown(text: string): string {
  const parts: { code: boolean; text: string }[] = [];
  const re = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push({ code: false, text: text.slice(lastIdx, m.index) });
    parts.push({ code: true, text: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push({ code: false, text: text.slice(lastIdx) });

  return parts.map(p => {
    if (p.code) return p.text;
    // **bold** → *bold* (non-greedy, must contain at least one char)
    return p.text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  }).join('');
}

/** Split a long message into chunks that fit Telegram's 4096-char limit */
function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a paragraph boundary
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) {
      // No good paragraph break — try single newline
      splitAt = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // No good newline break — hard split
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/** Ensure the main session exists; create it if not */
function ensureMainSession(): Session {
  let session = sessions.get(MAIN_SESSION_ID);
  if (!session) {
    const now = Date.now();
    session = {
      id: MAIN_SESSION_ID,
      name: 'Telegram Agent',
      cwd: CWD,
      createdAt: now,
      updatedAt: now,
      claudeSessionId: null,
      browserWs: new Set(),
      providerSession: null,
      providerSessionGen: 0,
      ready: false,
      status: 'open',
      runtimeStatus: 'stopped',
      replayDone: true,
      savedCommands: [],
      model: null,
      permissionMode: 'bypassPermissions',
      provider: DEFAULT_PROVIDER,
      remoteId: null,
      portForwards: [],
    };
    sessions.set(MAIN_SESSION_ID, session);
    saveSessions();
    log('[telegram] Created main session');
  }
  return session;
}

/** Start the Telegram bot (long-polling). No-ops if token is missing. */
export function startTelegramBot(port: number) {
  currentPort = port;
  const { botToken, chatId } = resolveSettings();

  if (!botToken) {
    log('[telegram] No bot token configured — skipping Telegram integration');
    return;
  }

  currentChatIdSetting = chatId;
  activeChatId = chatId || null;

  const session = ensureMainSession();

  // On startup, mark existing history as already notified so we don't
  // re-send old assistant messages.
  const state = getSessionState(MAIN_SESSION_ID);
  lastNotifiedMessageId = state.messages.length > 0
    ? state.messages[state.messages.length - 1].id
    : null;

  // Start the provider session if not already running
  if (!session.providerSession) {
    if (session.claudeSessionId) {
      session.replayDone = false;
      startProviderSession(session, port, session.claudeSessionId);
    } else {
      startProviderSession(session, port);
    }
  }

  /** Get the running main session, restarting it if needed. Returns null if not ready. */
  const getReadySession = async (ctx: any): Promise<Session | null> => {
    const session = sessions.get(MAIN_SESSION_ID);
    if (!session) {
      ctx.reply('Main session not found. Restarting...');
      ensureMainSession();
      return null;
    }
    if (!session.providerSession || !session.ready) {
      ctx.reply('Session is starting up, please wait...');
      if (!session.providerSession) {
        if (session.claudeSessionId) {
          session.replayDone = false;
          startProviderSession(session, port, session.claudeSessionId);
        } else {
          startProviderSession(session, port);
        }
      }
      return null;
    }
    return session;
  };

  /** Forward a (possibly multi-modal) user message through the provider. */
  const sendToProvider = async (
    session: Session,
    text: string,
    images: { media_type: string; data: string }[],
  ): Promise<void> => {
    session.replayDone = true;

    // Persist the user message so it shows up in the UI chat history.
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    };
    const added = addMessage(MAIN_SESSION_ID, userMsg);
    if (added) {
      broadcastToSession(MAIN_SESSION_ID, { type: 'message', sessionId: MAIN_SESSION_ID, message: userMsg });
    }

    // Mark the cutoff so notifyTelegramIfMainSession only sends assistant
    // messages added AFTER this point.
    const state = getSessionState(MAIN_SESSION_ID);
    lastNotifiedMessageId = state.messages.length > 0
      ? state.messages[state.messages.length - 1].id
      : null;

    // Post the "Claude is working…" ack BEFORE dispatching so the user gets
    // immediate proof the bot is alive. If a previous ack is still hanging
    // around (prior turn produced no text), let it be — it'll stay as a
    // breadcrumb.
    if (bot && activeChatId) {
      try {
        const initial = '⏳ Claude is working…';
        const ack = await bot.telegram.sendMessage(activeChatId, initial);
        pendingWorkingMessage = { chatId: activeChatId, messageId: ack.message_id };
        lastWorkingMessageText = initial;
        lastWorkingEditAt = Date.now();
      } catch (err) {
        logError(`[telegram] Failed to send working-ack: ${err}`);
        pendingWorkingMessage = null;
      }
    }

    if (!session.providerSession) return;
    await session.providerSession.sendUserMessage({ text, images });
  };

  /**
   * Transcribe an incoming voice / audio file via Deepgram and dispatch the
   * resulting text to Claude the same way a typed message would be. Shared
   * between the `voice` and `audio` handlers below.
   */
  const handleVoiceLike = async (
    ctx: any,
    fileId: string,
    kind: 'voice' | 'audio',
    byteSize: number | undefined,
  ) => {
    const chatId = ctx.chat.id;
    if (currentChatIdSetting && String(chatId) !== String(currentChatIdSetting)) {
      log(`[telegram] Ignored ${kind} from unauthorized chat ${chatId}`);
      return;
    }
    if (!activeChatId) activeChatId = chatId;

    const session = await getReadySession(ctx);
    if (!session) return;

    // Let the user know we're processing so they don't retry while Deepgram
    // is working. Kept lightweight — the downstream "⏳ Claude is working…"
    // ack gets posted by sendToProvider once we have the transcript.
    let transcribingMsgId: number | null = null;
    try {
      const ack = await ctx.reply('🎙️ Transcribing…');
      transcribingMsgId = ack.message_id;
    } catch {}

    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      log(`[telegram] ${kind} from ${chatId} (${byteSize ?? '?'} bytes) — transcribing via Deepgram`);
      const { transcript } = await transcribeAudioFromUrl(fileLink.toString());
      const clean = (transcript || '').trim();

      // Remove the "Transcribing…" breadcrumb — we'll surface the transcript
      // below so the user can SEE what was heard before Claude's reply.
      if (transcribingMsgId != null) {
        try { await ctx.telegram.deleteMessage(chatId, transcribingMsgId); } catch {}
      }

      if (!clean) {
        await ctx.reply('🎙️ No speech detected in the audio.');
        return;
      }

      // Echo the transcript back as an italic quote so the user can confirm
      // Deepgram heard them correctly. Telegram Markdown: `_italic_`.
      try {
        await ctx.reply(`🎙️ _${clean.replace(/_/g, '\\_')}_`, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(`🎙️ ${clean}`);
      }

      const caption = (ctx.message.caption || '').trim();
      const finalText = caption ? `${caption}\n\n${clean}` : clean;
      await sendToProvider(session, finalText, []);
    } catch (err) {
      logError(`[telegram] Failed to transcribe ${kind}: ${err}`);
      if (transcribingMsgId != null) {
        try { await ctx.telegram.deleteMessage(chatId, transcribingMsgId); } catch {}
      }
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes('API key')
        ? 'Configure your Deepgram API key in Settings to enable voice transcription.'
        : `Transcription failed: ${msg}`;
      try { await ctx.reply(`⚠️ ${hint}`); } catch {}
    }
  };

  /** Attach all handlers to a Telegraf instance. Factored out so the
   *  polling self-heal can re-attach them to a freshly-built instance
   *  after a 409 Conflict tears the polling loop down. */
  const registerHandlers = (b: Telegraf) => {
    b.command('start', (ctx) => {
      const chatId = ctx.chat.id;
      log(`[telegram] /start from chat ${chatId}`);
      ctx.reply(`Connected! Chat ID: ${chatId}\nSet TELEGRAM_CHAT_ID=${chatId} to restrict access to this chat.`);
      if (!activeChatId) activeChatId = chatId;
    });

    b.command('model', async (ctx) => {
      const chatId = ctx.chat.id;
      if (currentChatIdSetting && String(chatId) !== String(currentChatIdSetting)) return;

      const arg = ctx.message.text.replace(/^\/model(@\w+)?\s*/i, '').trim();
      const session = sessions.get(MAIN_SESSION_ID);

      if (!arg) {
        const current = session?.model || 'default';
        ctx.reply(
          `Current model: ${current}\n\n` +
          `Usage: /model <id>\n` +
          `  /model opus\n` +
          `  /model sonnet\n` +
          `  /model haiku\n` +
          `  /model claude-opus-4-7`
        );
        return;
      }

      if (!session) {
        ctx.reply('Main session not found.');
        return;
      }

      const newModel = arg.toLowerCase() === 'default' ? null : arg;
      session.model = newModel;
      saveSessions();
      log(`[telegram] Model changed to: ${newModel ?? 'default'}`);

      // Hot-swap via provider session — no restart needed.
      if (session.providerSession) {
        try {
          await session.providerSession.setModel(newModel);
          ctx.reply(`Model set to: ${newModel ?? 'default'}`);
        } catch (err) {
          ctx.reply(`Failed to switch model: ${err}`);
        }
      } else {
        ctx.reply(`Model preference saved: ${newModel ?? 'default'} (will apply on next session start).`);
      }
    });

    b.on('text', async (ctx) => {
      const chatId = ctx.chat.id;
      if (currentChatIdSetting && String(chatId) !== String(currentChatIdSetting)) {
        log(`[telegram] Ignored message from unauthorized chat ${chatId}`);
        return;
      }
      if (!activeChatId) activeChatId = chatId;

      const session = await getReadySession(ctx);
      if (!session) return;

      const text = ctx.message.text;
      log(`[telegram] Message from ${chatId}: ${text.slice(0, 80)}`);
      try {
        await sendToProvider(session, text, []);
      } catch (err) {
        logError(`[telegram] Failed to send message to Claude: ${err}`);
        ctx.reply('Failed to send message. The session may have disconnected.');
      }
    });

    b.on('photo', async (ctx) => {
      const chatId = ctx.chat.id;
      if (currentChatIdSetting && String(chatId) !== String(currentChatIdSetting)) {
        log(`[telegram] Ignored photo from unauthorized chat ${chatId}`);
        return;
      }
      if (!activeChatId) activeChatId = chatId;

      const session = await getReadySession(ctx);
      if (!session) return;

      try {
        // Pick the highest-resolution rendition
        const sizes = ctx.message.photo;
        const largest = sizes[sizes.length - 1];
        const fileLink = await ctx.telegram.getFileLink(largest.file_id);
        const res = await fetch(fileLink.toString());
        if (!res.ok) throw new Error(`Failed to download photo: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const data = buf.toString('base64');
        const caption = (ctx.message.caption || '').trim();

        log(`[telegram] Photo from ${chatId} (${buf.length} bytes)${caption ? ` caption: ${caption.slice(0, 60)}` : ''}`);
        await sendToProvider(session, caption, [{ media_type: 'image/jpeg', data }]);
      } catch (err) {
        logError(`[telegram] Failed to forward photo: ${err}`);
        ctx.reply('Failed to send image to Claude.');
      }
    });

    b.on('voice', async (ctx) => {
      const voice = ctx.message.voice;
      await handleVoiceLike(ctx, voice.file_id, 'voice', voice.file_size);
    });

    b.on('audio', async (ctx) => {
      const audio = ctx.message.audio;
      await handleVoiceLike(ctx, audio.file_id, 'audio', audio.file_size);
    });

    // Approve / Deny tool-permission button taps. The inline keyboard's
    // callback_data is encoded as `pa:<requestId>` (allow) or `pd:<requestId>`
    // (deny). On tap we resolve the same pendingDecisions promise the WS
    // permission_response handler uses, broadcast a permission_cancelled to
    // any other connected clients (so their UIs clear too), and edit the
    // Telegram message in place to a final ✅ / ❌ record.
    b.on('callback_query', async (ctx) => {
      const cq = ctx.callbackQuery as { data?: string; message?: { chat: { id: number | string }; message_id: number } };
      const data = cq.data;
      if (!data) { try { await ctx.answerCbQuery(); } catch {} return; }

      // Authorize: same chat-id check as text/photo handlers.
      const chatId = ctx.chat?.id;
      if (currentChatIdSetting && chatId !== undefined && String(chatId) !== String(currentChatIdSetting)) {
        try { await ctx.answerCbQuery('Not authorized'); } catch {}
        return;
      }

      const m = data.match(/^p([ad]):(.+)$/);
      if (!m) { try { await ctx.answerCbQuery(); } catch {} return; }
      const allow = m[1] === 'a';
      const requestId = m[2]!;

      // Find which session owns this pending request — needed for the
      // broadcast + state clear. If permRequest was already cleared (e.g.
      // resolved from another client first), foundSessionId stays null and
      // we just acknowledge with "already responded".
      let foundSessionId: string | null = null;
      let foundSession: Session | null = null;
      for (const [sid, s] of sessions) {
        const state = getSessionState(sid);
        if (state.permRequest?.requestId === requestId) {
          foundSessionId = sid;
          foundSession = s;
          break;
        }
      }

      const decision = allow
        ? { allow: true as const, updatedInput: {} as Record<string, unknown> }
        : { allow: false as const, interrupt: true };
      const resolved = resolvePermissionDecision(requestId, decision);

      if (!resolved && !foundSessionId) {
        try { await ctx.answerCbQuery('Already responded'); } catch {}
        // Strip the buttons from the now-stale message just in case.
        try {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        } catch {}
        return;
      }

      // Interrupt the agent on deny so it stops retrying the tool.
      if (!allow && foundSession?.providerSession) {
        try { await foundSession.providerSession.interrupt(); } catch {}
      }

      if (foundSessionId) {
        updateSessionState(foundSessionId, s => ({ ...s, permRequest: null }));
        broadcastToSession(foundSessionId, {
          type: 'permission_cancelled',
          sessionId: foundSessionId,
          requestId,
        });
      }

      // Edit the message in place: header swap to ✅ Approved / ❌ Denied,
      // strip the buttons so they can't be re-tapped.
      const original = cq.message ? (cq.message as { text?: string }).text || '' : '';
      // Original alert started with "🔔 *Permission needed* — `<tool>`\nSession: …"
      // — keep the body, just swap the first line.
      const restOfBody = original.replace(/^🔔[^\n]*\n?/, '');
      const newText = (allow ? '✅ Approved' : '❌ Denied') + (restOfBody ? '\n' + restOfBody : '');
      try {
        await ctx.editMessageText(newText, { reply_markup: { inline_keyboard: [] } });
      } catch (err) {
        logError(`[telegram] Failed to edit alert on tap: ${err}`);
      }

      try { await ctx.answerCbQuery(allow ? 'Approved' : 'Denied'); } catch {}
      log(`[telegram] Permission ${allow ? 'approved' : 'denied'} via inline button (req=${requestId.slice(0, 8)})`);
    });

    // Central error sink for handler exceptions. Polling-loop errors come
    // through the launch-promise rejection in launchPolling() instead, so
    // this won't fire on 409 Conflict.
    b.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[telegram] Handler error: ${msg}`);
    });
  };

  // Conflict (another instance is polling) → start at 60 s and grow
  // linearly to a 5 min cap, giving the rival lease time to release.
  // Other transient errors (network blip, DNS hiccup) → 30 s exponential.
  const getBackoffDelay = (isConflict: boolean): number => {
    if (isConflict) {
      return Math.min(60_000 * Math.max(1, consecutiveFailures), 300_000);
    }
    return Math.min(30_000 * 2 ** Math.max(0, consecutiveFailures - 1), 300_000);
  };

  const schedulePollingRestart = (delayMs: number) => {
    if (restartTimer) return;
    log(`[telegram] Will restart polling in ${Math.round(delayMs / 1000)}s`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      // Telegraf's internal polling state is not safe to re-launch on the
      // same instance after a fatal error — build a fresh one.
      if (bot) { try { bot.stop('SIGTERM'); } catch {} }
      bot = new Telegraf(botToken);
      registerHandlers(bot);
      launchPolling();
    }, delayMs);
  };

  // Pre-fetch botInfo (Telegraf-on-Bun workaround for the readonly
  // `this.botInfo ??=` assignment), then start long-polling. The
  // launch promise stays pending while polling is healthy and rejects
  // if the polling loop dies — that rejection is what triggers the
  // self-heal in schedulePollingRestart.
  const launchPolling = () => {
    if (!bot) return;
    const localBot = bot;
    (async () => {
      try {
        localBot.botInfo = await localBot.telegram.getMe();
      } catch (err) {
        if (localBot !== bot) return;
        logError(`[telegram] Failed to start bot: ${err}`);
        consecutiveFailures++;
        schedulePollingRestart(getBackoffDelay(false));
        return;
      }

      const launchPromise = localBot.launch({
        allowedUpdates: ['message', 'callback_query', 'edited_message', 'channel_post'],
        dropPendingUpdates: false,
      });

      log(consecutiveFailures > 0
        ? '[telegram] Polling resumed'
        : '[telegram] Bot started (long-polling)');
      consecutiveFailures = 0;

      launchPromise
        .then(() => {
          // Polling stopped cleanly via bot.stop(). No restart needed.
          if (localBot === bot) log('[telegram] Polling stopped');
        })
        .catch((err: unknown) => {
          // Stale callback — bot was already replaced by a restart.
          if (localBot !== bot) return;
          const msg = err instanceof Error ? err.message : String(err);
          const isConflict = /409|Conflict|terminated by other/i.test(msg);
          if (isConflict) {
            log('[telegram] getUpdates conflict — another instance is polling. Backing off and retrying.');
          } else {
            logError(`[telegram] Polling died: ${msg}`);
          }
          consecutiveFailures++;
          schedulePollingRestart(getBackoffDelay(isConflict));
        });
    })();
  };

  bot = new Telegraf(botToken);
  registerHandlers(bot);
  launchPolling();
}

/** Send a response back to the active Telegram chat. If there's a pending
 *  "⏳ Claude is working…" ack, the FIRST chunk edits that message in place
 *  so the single Telegram bubble morphs from "working" → "here's the
 *  answer". Additional chunks post as new messages below. */
export async function sendTelegramResponse(text: string) {
  if (!bot || !activeChatId) return;
  if (!text.trim()) return;

  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const formatted = toTelegramMarkdown(chunk);

    // First chunk + pending ack → EDIT the working message.
    if (i === 0 && pendingWorkingMessage) {
      const { chatId, messageId } = pendingWorkingMessage;
      pendingWorkingMessage = null; // consume it
      lastWorkingMessageText = '';
      try {
        await bot.telegram.editMessageText(chatId, messageId, undefined, formatted, { parse_mode: 'Markdown' });
        continue;
      } catch {
        try {
          await bot.telegram.editMessageText(chatId, messageId, undefined, chunk);
          continue;
        } catch (err) {
          // Edit failed (message too old, deleted, etc.) — fall through and
          // send as a new message so the reply isn't lost.
          logError(`[telegram] Failed to edit working-ack: ${err}`);
        }
      }
    }

    try {
      await bot.telegram.sendMessage(activeChatId, formatted, { parse_mode: 'Markdown' });
    } catch (err) {
      // Markdown parsing failed (unbalanced *, _, etc.) — retry as plain text
      try {
        await bot.telegram.sendMessage(activeChatId, chunk);
      } catch (retryErr) {
        logError(`[telegram] Failed to send message: ${retryErr}`);
      }
    }
  }
}

/**
 * Send an unsolicited alert (e.g. permission request, turn complete) to the
 * configured Telegram chat. Uses the persisted chat ID from settings so it
 * works even if no user has started a /conversation recently.
 *
 * Returns `{ chatId, messageId }` for the FIRST chunk sent so callers can
 * later edit it (e.g. swap a permission-request alert into a "Approved" /
 * "Denied" alert when the user responds in the UI). Returns null when the
 * bot isn't configured or the send fails.
 */
export type InlineKeyboard = { text: string; callback_data: string }[][];

export async function sendTelegramAlert(
  text: string,
  opts?: { keyboard?: InlineKeyboard },
): Promise<{ chatId: string | number; messageId: number } | null> {
  if (!bot) return null;
  if (!text.trim()) return null;
  const target = activeChatId || currentChatIdSetting || null;
  if (!target) return null;

  const chunks = splitMessage(text);
  let firstSent: { chatId: string | number; messageId: number } | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const formatted = toTelegramMarkdown(chunk);
    let res: { message_id: number } | null = null;
    // Only attach the keyboard to the first chunk so the buttons don't
    // appear on every continuation bubble for very long alerts.
    const extras: { parse_mode: 'Markdown'; reply_markup?: { inline_keyboard: InlineKeyboard } } = { parse_mode: 'Markdown' };
    if (i === 0 && opts?.keyboard) extras.reply_markup = { inline_keyboard: opts.keyboard };
    try {
      res = await bot.telegram.sendMessage(target, formatted, extras);
    } catch {
      try {
        const fallback: { reply_markup?: { inline_keyboard: InlineKeyboard } } = {};
        if (i === 0 && opts?.keyboard) fallback.reply_markup = { inline_keyboard: opts.keyboard };
        res = await bot.telegram.sendMessage(target, chunk, fallback);
      } catch (err) {
        logError(`[telegram] Failed to send alert: ${err}`);
      }
    }
    if (i === 0 && res?.message_id) {
      firstSent = { chatId: target, messageId: res.message_id };
    }
  }
  return firstSent;
}

/**
 * Edit the text of a previously-sent Telegram message. Used to update a
 * pending permission alert into "Approved" / "Denied" once the user
 * responds in the desktop / mobile UI. No-ops silently if the bot isn't
 * configured or the edit fails (e.g. message too old, already deleted).
 */
export async function editTelegramMessage(
  chatId: string | number,
  messageId: number,
  text: string,
): Promise<void> {
  if (!bot) return;
  if (!text.trim()) return;
  const formatted = toTelegramMarkdown(text);
  // Empty inline_keyboard explicitly removes any approve/deny buttons that
  // were attached to the original alert — once a permission is resolved
  // we don't want a stale button being tapped.
  const stripButtons = { inline_keyboard: [] as InlineKeyboard };
  try {
    await bot.telegram.editMessageText(chatId, messageId, undefined, formatted, {
      parse_mode: 'Markdown',
      reply_markup: stripButtons,
    });
  } catch {
    try {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        reply_markup: stripButtons,
      });
    } catch (err) {
      logError(`[telegram] Failed to edit alert ${messageId}: ${err}`);
    }
  }
}

/** Notify Telegram if the turn completed on the main session */
export function notifyTelegramIfMainSession(sessionId: string) {
  if (sessionId !== MAIN_SESSION_ID) return;
  if (!bot || !activeChatId) return;

  const state = getSessionState(sessionId);
  const messages = state.messages;
  if (messages.length === 0) return;

  // Find the index after the last notified assistant message (exclusive)
  let startIdx = 0;
  if (lastNotifiedMessageId) {
    const lastIdx = messages.findIndex(m => m.id === lastNotifiedMessageId);
    startIdx = lastIdx >= 0 ? lastIdx + 1 : 0;
  }

  // Send each new assistant text message as a separate Telegram bubble.
  // The FIRST one may edit the pending "⏳ Claude is working…" ack rather
  // than post a fresh bubble (see sendTelegramResponse).
  let sentAny = false;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && !msg.toolName && !msg.isToolResult && msg.content && msg.content.trim()) {
      sendTelegramResponse(msg.content);
      lastNotifiedMessageId = msg.id;
      sentAny = true;
    }
  }

  // Turn completed but the agent produced no assistant text (e.g. all
  // work was tool calls, or the run errored out). Don't leave the
  // "⏳ Claude is working…" ack hanging forever — repurpose it as the
  // terminal marker so the user knows the turn finished.
  if (!sentAny && pendingWorkingMessage) {
    const { chatId, messageId } = pendingWorkingMessage;
    pendingWorkingMessage = null;
    lastWorkingMessageText = '';
    bot.telegram.editMessageText(chatId, messageId, undefined, '✅ Turn completed (no text response)')
      .catch((err: unknown) => logError(`[telegram] Failed to finalize ack: ${err}`));
  }
}

/**
 * Amend the pending "⏳ Claude is working…" message to surface the tool
 * Claude is currently using, so the user can watch progress from Telegram
 * without opening the UI. No-ops when there's no pending ack (i.e. outside
 * a Telegram-driven turn, or after the first textual response arrived and
 * consumed the ack).
 *
 * Throttled to ~1 edit per 1.5 s and skips no-op edits (same text) to stay
 * under Telegram's per-chat rate limit.
 */
export async function updateWorkingWithTool(toolName: string, summary: string): Promise<void> {
  if (!bot) return;
  if (!pendingWorkingMessage) return;

  const now = Date.now();
  if (now - lastWorkingEditAt < WORKING_EDIT_THROTTLE_MS) return;

  const cleanedSummary = (summary || '').trim().replace(/\s+/g, ' ');
  const line = cleanedSummary
    ? `${toolName}: ${cleanedSummary.length > 80 ? cleanedSummary.slice(0, 79) + '…' : cleanedSummary}`
    : toolName;
  const text = `⏳ Claude is working…\n\n🔧 ${line}`;
  if (text === lastWorkingMessageText) return;

  const { chatId, messageId } = pendingWorkingMessage;
  try {
    await bot.telegram.editMessageText(chatId, messageId, undefined, text);
    lastWorkingMessageText = text;
    lastWorkingEditAt = now;
  } catch (err) {
    // Ignore — likely hit a rate limit or the message was already edited.
    // Not worth logging noisily during normal operation.
  }
}

/** Stop the Telegram bot gracefully */
export function stopTelegramBot() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  consecutiveFailures = 0;
  if (bot) {
    bot.stop('SIGTERM');
    bot = null;
    activeChatId = null;
    log('[telegram] Bot stopped');
  }
}

/** Restart the Telegram bot with current persisted settings */
export function restartTelegramBot(port?: number) {
  stopTelegramBot();
  const p = port ?? currentPort;
  if (p > 0) startTelegramBot(p);
}

/** Whether the bot is currently running */
export function isTelegramBotRunning(): boolean {
  return bot !== null;
}
