/**
 * wacli `message.received` webhook payloads and WhatsApp JID handling.
 *
 * Payload (from `wa webhook test`): { event, timestamp, account, id, chat,
 * isGroup, from, fromMe, pushName, type, text, mediaMimetype,
 * messageTimestamp }. Some chats arrive by LID (`…@lid`), which `wacli text`
 * cannot deliver to — the channel's LID map translates them to phone JIDs.
 */

export interface WhatsAppMessage {
  account: string | null;
  id: string;
  /** Chat as wacli reported it (used for read receipts). */
  chat: string;
  /** Chat after LID mapping — the address replies go to. */
  replyJid: string;
  from: string;
  isGroup: boolean;
  fromMe: boolean;
  pushName: string | null;
  type: string;
  text: string;
  mime: string | null;
  at: number;
  test: boolean;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'voice', 'document', 'sticker']);

export function isMediaType(type: string): boolean {
  return MEDIA_TYPES.has(type);
}

export function isVoiceType(type: string, mime: string | null): boolean {
  return type === 'ptt' || type === 'voice' || type === 'audio' || (!!mime && mime.startsWith('audio/'));
}

/**
 * Canonical JID: lower-case, no device suffix (`521…:25@s.whatsapp.net`),
 * bare numbers and `+52 1 …` become `<digits>@s.whatsapp.net`.
 */
export function normalizeJid(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  if (/^\+?[\d\s().-]+$/.test(s)) {
    const digits = s.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
  }
  const at = s.indexOf('@');
  if (at < 0) return s;
  const user = s.slice(0, at).split(':')[0]!;
  const server = s.slice(at + 1) === 'c.us' ? 's.whatsapp.net' : s.slice(at + 1);
  return `${user}@${server}`;
}

/**
 * Mexican and Argentine mobiles exist with and without the mobile prefix
 * (52 ↔ 521, 54 ↔ 549); owners type either, WhatsApp uses one.
 */
export function jidVariants(jid: string): string[] {
  const n = normalizeJid(jid);
  const m = /^(\d+)@s\.whatsapp\.net$/.exec(n);
  if (!m) return n ? [n] : [];
  const d = m[1]!;
  const out = [n];
  if (/^52\d{10}$/.test(d)) out.push(`521${d.slice(2)}@s.whatsapp.net`);
  if (/^521\d{10}$/.test(d)) out.push(`52${d.slice(3)}@s.whatsapp.net`);
  if (/^54\d{10}$/.test(d)) out.push(`549${d.slice(2)}@s.whatsapp.net`);
  if (/^549\d{10}$/.test(d)) out.push(`54${d.slice(3)}@s.whatsapp.net`);
  return out;
}

/**
 * A LID's phone JID from the channel's map. Only `…@lid` addresses are
 * translated: a map entry can't make a phone number stand for another one.
 */
export function mapLid(jid: string, lidMap: Record<string, string>): string {
  const n = normalizeJid(jid);
  if (!n.endsWith('@lid')) return n;
  const mapped = Object.hasOwn(lidMap, n) ? lidMap[n] : undefined;
  return typeof mapped === 'string' && mapped ? normalizeJid(mapped) : n;
}

export function isGroupJid(jid: string): boolean {
  return jid.trim().toLowerCase().endsWith('@g.us');
}

/** A one-to-one chat: a phone JID or a LID. Groups, status broadcasts and newsletters are not. */
export function isDirectJid(jid: string): boolean {
  return /@(s\.whatsapp\.net|lid)$/.test(normalizeJid(jid));
}

/**
 * Owner = a one-to-one chat whose sender (after LID mapping) is one of
 * owner.whatsappJids. Replies go to the chat, so the chat must be the owner
 * too — or a LID the map doesn't know yet (whose it is can't be told, but in
 * a one-to-one chat it is the sender's). A chat that resolves to anybody
 * else's number is never trusted, whatever the sender field says.
 */
export function isOwnerMessage(msg: Pick<WhatsAppMessage, 'from' | 'chat' | 'isGroup' | 'fromMe'>, ownerJids: string[], lidMap: Record<string, string>): boolean {
  if (msg.isGroup || msg.fromMe) return false;
  const chat = normalizeJid(msg.chat || msg.from);
  if (!isDirectJid(chat)) return false;
  const owners = new Set(ownerJids.flatMap(jidVariants));
  if (owners.size === 0) return false;
  const isOwnerId = (jid: string) => {
    const n = normalizeJid(jid);
    return !!n && (owners.has(n) || owners.has(mapLid(n, lidMap)));
  };
  if (!isOwnerId(msg.from || msg.chat)) return false;
  if (isOwnerId(chat)) return true;
  return chat.endsWith('@lid') && mapLid(chat, lidMap) === chat;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Validate a webhook body. Null for anything that is not a received message. */
export function parseWacliPayload(raw: unknown, lidMap: Record<string, string> = {}): WhatsAppMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.event !== undefined && p.event !== 'message.received') return null;
  const id = str(p.id).trim();
  const chat = str(p.chat).trim() || str(p.from).trim();
  if (!id || !chat || id.length > 200 || chat.length > 200) return null;
  const from = str(p.from).trim() || chat;
  const ts = typeof p.messageTimestamp === 'number' ? p.messageTimestamp * 1000 : typeof p.timestamp === 'number' ? p.timestamp : Date.now();
  return {
    account: str(p.account).trim() || null,
    id,
    chat,
    replyJid: mapLid(chat, lidMap),
    from,
    // A group JID is a group whatever the flag says (fail closed: never a direct chat).
    isGroup: p.isGroup === true || isGroupJid(chat),
    fromMe: p.fromMe === true,
    pushName: str(p.pushName).trim().slice(0, 100) || null,
    type: str(p.type).trim().toLowerCase() || 'text',
    text: str(p.text).slice(0, 20_000),
    mime: str(p.mediaMimetype).trim() || null,
    at: Number.isFinite(ts) ? ts : Date.now(),
    test: p.test === true,
  };
}

/** What the agent / inbox sees for media it could not fetch. */
export function mediaPlaceholder(type: string, reason: 'not-downloaded' | 'not-downloadable'): string {
  const label = type === 'ptt' || type === 'voice' ? 'voice note' : type === 'audio' ? 'audio' : type;
  return reason === 'not-downloaded' ? `(${label})` : `(${label} — not downloadable)`;
}

/**
 * One LID map entry, or null: the key must be a LID and the value a phone
 * JID, so an entry can only ever name a LID's number.
 */
export function lidMapEntry(rawKey: string, rawValue: string): [string, string] | null {
  const k = rawKey.trim();
  const key = normalizeJid(k.includes('@') ? k : `${k}@lid`);
  const val = normalizeJid(rawValue);
  if (!/^[\w.-]+@lid$/.test(key) || !/^\d+@s\.whatsapp\.net$/.test(val)) return null;
  return [key, val];
}

/** Parse "lid=phone" lines (UI and env-style config). */
export function parseLidMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[\n,]+/)) {
    const [k, v] = part.split('=').map(s => s?.trim());
    if (!k || !v) continue;
    const entry = lidMapEntry(k, v);
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}
