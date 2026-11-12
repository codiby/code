/**
 * Who a send_message recipient is, by the people directory — so the approval
 * says "Send a message to Ana López <5215550009999@s.whatsapp.net>" instead of
 * a bare number the owner has to recognise.
 *
 * Read-only (one query over a small table, only for send_message), so it is
 * safe for the preview phase. Imports memory's side-effect-free people module
 * rather than its index, so the policy area doesn't change the order areas
 * register in.
 */

import { getChannel } from '../outbox';
import { findPersonByHandle, type HandleChannel } from '../memory/people';
import type { PeopleLookup } from './classify';

const TELEGRAM_CHAT_ID = /^-?\d{3,20}$/;

/** Directories to look in for `address`: the channel's own when it is known, else what the address looks like. */
function handleChannels(address: string, channelId?: string): HandleChannel[] {
  const type = channelId ? getChannel(channelId)?.type : undefined;
  if (type === 'telegram') return ['telegram'];
  if (type === 'whatsapp') return ['whatsapp'];
  if (address.includes('@')) return ['whatsapp'];
  // A bare number is a Telegram chat id or a phone, and send_message takes either.
  return TELEGRAM_CHAT_ID.test(address.trim()) ? ['telegram', 'whatsapp'] : ['whatsapp'];
}

export const peopleLookup: PeopleLookup = {
  nameFor(address, channelId) {
    for (const channel of handleChannels(address, channelId)) {
      const person = findPersonByHandle(channel, address);
      if (person) return person.name;
    }
    return null;
  },
};
