import { Telegraf } from 'telegraf';
import { randomUUID } from 'crypto';
import { log, logError } from './logger';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MAIN_SESSION_ID, CWD } from './config';
import { sessions, saveSessions } from './sessions';
import { startProviderSession } from './provider/lifecycle';
import { DEFAULT_PROVIDER } from './provider/registry';
import { getSessionState, addMessage, type ChatMessage } from './state';
import { loadTelegramSettings } from './storage';
import type { Session } from './types';

let bot: Telegraf | null = null;
let currentChatIdSetting: string = '';
let activeChatId: string | number | null = null;
let currentPort = 0;
let lastNotifiedMessageId: string | null = null;

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
    session = {
      id: MAIN_SESSION_ID,
      name: 'Telegram Agent',
      cwd: CWD,
      createdAt: Date.now(),
      claudeSessionId: null,
      browserWs: new Set(),
      providerSession: null,
      ready: false,
      status: 'stopped',
      replayDone: true,
      savedCommands: [],
      model: null,
      permissionMode: 'bypassPermissions',
      provider: DEFAULT_PROVIDER,
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

  bot = new Telegraf(botToken);

  bot.command('start', (ctx) => {
    const chatId = ctx.chat.id;
    log(`[telegram] /start from chat ${chatId}`);
    ctx.reply(`Connected! Chat ID: ${chatId}\nSet TELEGRAM_CHAT_ID=${chatId} to restrict access to this chat.`);
    if (!activeChatId) activeChatId = chatId;
  });

  bot.command('model', async (ctx) => {
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

    if (!session.providerSession) return;
    await session.providerSession.sendUserMessage({ text, images });
  };

  bot.on('text', async (ctx) => {
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

  bot.on('photo', async (ctx) => {
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

  bot.launch().then(() => {
    log('[telegram] Bot started (long-polling)');
  }).catch((err) => {
    logError(`[telegram] Failed to start bot: ${err}`);
  });
}

/** Send a response back to the active Telegram chat */
export async function sendTelegramResponse(text: string) {
  if (!bot || !activeChatId) return;
  if (!text.trim()) return;

  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const formatted = toTelegramMarkdown(chunk);
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
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && !msg.toolName && !msg.isToolResult && msg.content && msg.content.trim()) {
      sendTelegramResponse(msg.content);
      lastNotifiedMessageId = msg.id;
    }
  }
}

/** Stop the Telegram bot gracefully */
export function stopTelegramBot() {
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
