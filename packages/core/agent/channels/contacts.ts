/**
 * Recipients by name. Memory's people directory knows "Ana", "mi esposa" and
 * their handles; this turns a person into an address one of the running
 * channels can deliver to, and puts a known name on an inbox sender.
 *
 * Resolving is its own read-only step (`resolve_contact`), never something
 * send_message does after the fact: the policy decides on send_message's
 * input, so the owner must be asked to approve the real address. If
 * send_message took "Ana" and picked a number afterwards, the approval (and
 * any rule pinned from it) would be for a name — and the agent can edit the
 * directory without approval, so that name could quietly point somewhere else.
 *
 * Imports memory's side-effect-free modules rather than its index, so loading
 * channels doesn't change the order areas register in.
 */

import { getChannelConfig } from './config';
import { getChannel, listChannels } from '../outbox';
import { findPeople, findPersonByHandle, type Person } from '../memory/people';
import { phoneToWhatsAppJid } from '../memory/phone';
import { foldText, wordTokens } from '../memory/text';
import type { ChannelAdapter, ChannelType } from '../types';
import { mapLid } from './whatsapp/payload';

const TELEGRAM_CHAT_ID = /^-?\d{3,20}$/;
const WHATSAPP_JID = /@(s\.whatsapp\.net|c\.us|lid|g\.us)$/i;
const PHONE_LIKE = /^\+?[\d\s().-]{8,20}$/;

/** Is `to` already an address `type` can deliver to (as opposed to a name)? */
export function isAddressFor(type: ChannelType, to: string): boolean {
  const v = to.trim();
  if (type === 'telegram') return TELEGRAM_CHAT_ID.test(v);
  if (type === 'whatsapp') return WHATSAPP_JID.test(v) || (PHONE_LIKE.test(v) && v.replace(/\D/g, '').length >= 8);
  // Webhook peers are request ids or "owner": whatever the agent names, it named it explicitly.
  return v.length > 0;
}

/** Looks like a Telegram chat id or a WhatsApp number/JID on some channel. */
export function looksLikeAddress(to: string): boolean {
  return isAddressFor('telegram', to) || isAddressFor('whatsapp', to);
}

export interface ContactAddress {
  channelId: string;
  channelType: ChannelType;
  channelName: string;
  connected: boolean;
  /** What send_message's `to` should be. */
  to: string;
}

/** Every address the person's handles give on `channel` (first = the one they were saved with first). */
export function addressesOn(person: Person, channel: ChannelAdapter): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => { if (v && !out.includes(v)) out.push(v); };
  if (channel.type === 'whatsapp') {
    // Groups are not a person; a stored group handle never stands for them.
    for (const h of person.handles.whatsapp ?? []) if (!h.endsWith('@g.us')) add(h);
    for (const p of person.handles.phone ?? []) add(phoneToWhatsAppJid(p));
  } else if (channel.type === 'telegram') {
    // Bots can only message numeric chat ids; an @username is not deliverable.
    for (const h of person.handles.telegram ?? []) if (TELEGRAM_CHAT_ID.test(h)) add(h);
  }
  return out;
}

export interface ContactMatch {
  personId: string;
  name: string;
  relation: string | null;
  aliases: string[];
  addresses: ContactAddress[];
  /** Why there is no address, when there is none. */
  note?: string;
}

export interface ContactResolution {
  query: string;
  matches: ContactMatch[];
  /** The one address to use, when the query names exactly one person with exactly one reachable address. */
  best?: { channelId: string; to: string; name: string };
  next: string;
}

/** Name or alias equals the query, or every query word starts a word of it ("ana lopez" → "Ana María López"). */
function strongMatch(person: Person, query: string): boolean {
  const q = foldText(query);
  const qTokens = wordTokens(q);
  for (const n of [person.name, ...person.aliases].map(foldText)) {
    if (n === q) return true;
    const words = wordTokens(n);
    if (qTokens.length > 0 && qTokens.every(t => words.some(w => w.startsWith(t)))) return true;
  }
  return !!person.relation && foldText(person.relation) === q;
}

function matchFor(person: Person, channels: ChannelAdapter[]): ContactMatch {
  const addresses: ContactAddress[] = [];
  for (const ch of channels) {
    const connected = ch.status().connected;
    for (const to of addressesOn(person, ch)) {
      addresses.push({ channelId: ch.id, channelType: ch.type, channelName: ch.name, connected, to });
    }
  }
  const telegramUsernames = (person.handles.telegram ?? []).filter(h => !TELEGRAM_CHAT_ID.test(h));
  let note: string | undefined;
  if (addresses.length === 0) {
    note = telegramUsernames.length && channels.some(c => c.type === 'telegram')
      ? `Only a Telegram @username is saved (${telegramUsernames.join(', ')}); bots can only message numeric chat ids.`
      : channels.length === 0
        ? 'No messaging channel is running.'
        : 'No handle saved for a running channel — ask the owner, then save it with people_upsert.';
  }
  return { personId: person.id, name: person.name, relation: person.relation, aliases: person.aliases, addresses, ...(note ? { note } : {}) };
}

/** Find who `query` refers to and the addresses send_message can use for them. */
export function resolveContact(query: string, opts: { channelId?: string } = {}): ContactResolution {
  const q = query.trim();
  const only = opts.channelId ? getChannel(opts.channelId) : null;
  const channels = (only ? [only] : listChannels()).filter(c => c.type === 'whatsapp' || c.type === 'telegram');
  const people = q ? findPeople(q, 5) : [];
  const strong = people.filter(p => strongMatch(p, q));
  // Prefer people the query actually names over loose hits (a word in someone's notes).
  const candidates = strong.length ? strong : people;
  const matches = candidates.map(p => matchFor(p, channels));

  let best: ContactResolution['best'];
  let next: string;
  if (matches.length === 0) {
    next = `Nobody in the people directory matches "${q}". Ask the owner who they mean and how to reach them, then save it with people_upsert.`;
  } else if (matches.length > 1) {
    next = `Several people match "${q}" — ask the owner which one they mean before sending anything.`;
  } else {
    const m = matches[0]!;
    const reachable = m.addresses.filter(a => a.connected);
    if (reachable.length === 1 && strong.length === 1) {
      best = { channelId: reachable[0]!.channelId, to: reachable[0]!.to, name: m.name };
      next = `Call send_message with channelId "${best.channelId}" and to "${best.to}".`;
    } else if (reachable.length > 1) {
      next = `${m.name} can be reached at more than one address — pick one (pass its channelId and to to send_message), or ask the owner which they prefer.`;
    } else if (reachable.length === 1) {
      next = `Closest match is ${m.name}; check that's who the owner means, then call send_message with channelId "${reachable[0]!.channelId}" and to "${reachable[0]!.to}".`;
    } else {
      next = m.note ?? `${m.name} has no address on a connected channel right now.`;
    }
  }
  return { query: q, matches, ...(best ? { best } : {}), next };
}

/**
 * The directory entry for an inbox sender, matched by handle — a name the
 * owner saved, unlike the display name the sender picked for themselves.
 */
export function contactForPeer(channelType: string, channelId: string, peer: string): Person | null {
  try {
    if (channelType === 'whatsapp') {
      const cfg = getChannelConfig(channelId);
      const lidMap = cfg?.type === 'whatsapp' ? cfg.lidMap : {};
      const mapped = mapLid(peer, lidMap);
      return findPersonByHandle('whatsapp', mapped) ?? (mapped !== peer ? findPersonByHandle('whatsapp', peer) : null);
    }
    if (channelType === 'telegram') return findPersonByHandle('telegram', peer);
  } catch {
    // The directory is a nicety here: an inbox listing must not fail over it.
  }
  return null;
}
