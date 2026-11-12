/**
 * Minimal Telegram Bot API client over `fetch`.
 *
 * Only what the agent's Telegram channel uses. It is an interface so tests
 * drive the adapter with a fake and never reach api.telegram.org. The bot
 * token is part of every URL, so URLs never appear in errors or logs.
 *
 * Failures come in two kinds, because the outbox retries whatever throws:
 * `TelegramApiError` / plain `Error` — Telegram refused the call or never got
 * it, so a retry is safe; `DeliveryUncertainError` — it timed out, the
 * connection dropped, or Telegram answered 5xx, so the message may already
 * be in the chat and a retry could post it twice.
 */

import { DeliveryUncertainError, errorText, failedBeforeSending } from '../delivery';

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgFileRef {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TgPhotoSize extends TgFileRef {
  width: number;
  height: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgFileRef & { duration?: number };
  audio?: TgFileRef & { duration?: number; title?: string };
  document?: TgFileRef;
  video?: TgFileRef;
  video_note?: TgFileRef;
  sticker?: { emoji?: string };
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string; first_name?: string; last_name?: string };
  /** Bot API 7+: who wrote a forwarded message (user, hidden_user, chat or channel). */
  forward_origin?: {
    type: string;
    date?: number;
    sender_user?: TgUser;
    sender_user_name?: string;
    sender_chat?: TgChat;
    chat?: TgChat;
    author_signature?: string;
  };
  /** Pre-7.0 forward fields. */
  forward_from?: TgUser;
  forward_from_chat?: TgChat;
  forward_sender_name?: string;
  forward_date?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export type InlineKeyboard = { text: string; callback_data: string }[][];

export interface SendTextOptions {
  markdown?: boolean;
  keyboard?: InlineKeyboard;
  replyTo?: number;
  /** Deliver without a notification sound (low-priority and quiet-hours messages). */
  silent?: boolean;
}

export interface EditTextOptions {
  markdown?: boolean;
  /** null strips any buttons; undefined leaves them alone. */
  keyboard?: InlineKeyboard | null;
}

export type ChatAction = 'typing' | 'upload_document' | 'upload_photo' | 'record_voice';
export type UploadKind = 'photo' | 'document' | 'voice' | 'audio';

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(params: { offset?: number; timeout: number; allowedUpdates: string[] }, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string, opts?: SendTextOptions): Promise<{ message_id: number }>;
  editMessageText(chatId: string, messageId: number, text: string, opts?: EditTextOptions): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  sendChatAction(chatId: string, action: ChatAction): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  /** Download a file by id; rejects above `maxBytes` before fetching the body when Telegram reports the size. */
  downloadFile(fileId: string, maxBytes: number): Promise<{ data: Uint8Array; filePath: string }>;
  sendFile(chatId: string, kind: UploadKind, file: { path: string; name?: string; mime?: string }, caption?: string, opts?: { silent?: boolean }): Promise<{ message_id: number }>;
}

export class TelegramApiError extends Error {
  constructor(readonly code: number, readonly description: string, readonly retryAfter?: number) {
    super(`Telegram ${code}: ${description}`);
  }
}

/** Bot API getFile limit — larger files cannot be downloaded by bots. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export function isParseError(err: unknown): boolean {
  return err instanceof TelegramApiError && err.code === 400 && /parse entities|can't find end|unsupported start tag/i.test(err.description);
}

export function isNotModified(err: unknown): boolean {
  return err instanceof TelegramApiError && err.code === 400 && /message is not modified/i.test(err.description);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createTelegramApi(token: string, fetchImpl: FetchLike = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`;
  // Scrub the token from anything that might carry the URL (network errors).
  const scrub = (s: string) => (token ? s.split(token).join('<token>') : s);

  async function call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    };
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${method}`, init);
    } catch (err) {
      const message = scrub(errorText(err));
      // Refused / unresolvable: the request never reached Telegram.
      if (failedBeforeSending(err)) throw new Error(message);
      // Timed out or dropped mid-request: Telegram may have acted on it.
      throw new DeliveryUncertainError(`Telegram did not answer: ${message}`);
    }
    let data: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } = {};
    let parsed = false;
    try { data = await res.json(); parsed = true; } catch {}
    if (res.ok && parsed && data.ok) return data.result as T;
    const code = data.error_code ?? res.status;
    const description = scrub(data.description ?? res.statusText ?? 'error');
    // A 2xx whose body we couldn't read was accepted; a 5xx (often a gateway
    // timing out in front of Telegram) may have been processed.
    if ((res.ok && !parsed) || code >= 500) throw new DeliveryUncertainError(`Telegram ${code}: ${description}`);
    throw new TelegramApiError(code, description, data.parameters?.retry_after);
  }

  const markup = (keyboard: InlineKeyboard | null | undefined) =>
    keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard ?? [] } };

  return {
    getMe: () => call<TgUser>('getMe', {}),
    getUpdates: ({ offset, timeout, allowedUpdates }, signal) =>
      call<TgUpdate[]>('getUpdates', { offset, timeout, allowed_updates: allowedUpdates }, signal, (timeout + 15) * 1000),
    sendMessage: (chatId, text, opts = {}) => call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...(opts.markdown ? { parse_mode: 'Markdown' } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
      link_preview_options: { is_disabled: true },
      ...markup(opts.keyboard),
    }),
    async editMessageText(chatId, messageId, text, opts = {}) {
      await call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(opts.markdown ? { parse_mode: 'Markdown' } : {}),
        link_preview_options: { is_disabled: true },
        ...markup(opts.keyboard),
      });
    },
    async deleteMessage(chatId, messageId) {
      await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
    async sendChatAction(chatId, action) {
      await call('sendChatAction', { chat_id: chatId, action });
    },
    async answerCallbackQuery(id, text) {
      await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
    },
    async downloadFile(fileId, maxBytes) {
      const file = await call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
      if (!file.file_path) throw new Error('Telegram did not return a file path');
      if (file.file_size && file.file_size > maxBytes) throw new Error(`File is too large (${Math.round(file.file_size / 1024 / 1024)} MB)`);
      let res: Response;
      try {
        res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        throw new Error(scrub(err instanceof Error ? err.message : String(err)));
      }
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.byteLength > maxBytes) throw new Error('File is too large');
      return { data, filePath: file.file_path };
    },
    sendFile(chatId, kind, file, caption, opts = {}) {
      const form = new FormData();
      form.set('chat_id', chatId);
      if (caption) form.set('caption', caption.slice(0, 1024));
      if (opts.silent) form.set('disable_notification', 'true');
      const blob = Bun.file(file.path, file.mime ? { type: file.mime } : undefined);
      form.set(kind, blob, file.name || file.path.split('/').pop() || 'file');
      const method = { photo: 'sendPhoto', document: 'sendDocument', voice: 'sendVoice', audio: 'sendAudio' }[kind];
      return call<{ message_id: number }>(method, form, undefined, 120_000);
    },
  };
}
