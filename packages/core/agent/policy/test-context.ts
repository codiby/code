/** Shared classifier context for the policy tests (classify, defaults). */

import type { ClassifyContext } from './classify';

// A home that doesn't exist, so symlink resolution can't depend on the test machine.
export const HOME = '/nonexistent-codiby-test/home/tester';
export const WS = `${HOME}/agent`;

const snapshot = [
  '- heading "Your cart" [ref=e1]',
  '- button "Place your order" [ref=e7]',
  '- link "Read more" [ref=e9]',
].join('\n');

export const ctx: ClassifyContext = {
  workspaceDir: WS,
  home: HOME,
  codibyDir: `${HOME}/.codiby`,
  // Pinned, so the cases don't depend on CLAUDE_UI_PORT in the environment.
  bridgePort: 3111,
  owner: { telegramChatIds: ['111222'], whatsappJids: ['5215512345678@s.whatsapp.net'], emails: ['me@example.com'] },
  browser: {
    pageUrl: name => (name === 'shop' ? 'https://shop.example.com/cart' : name === 'docs' ? 'https://docs.example.com/guide' : null),
    refLabel: (name, ref) => (name === 'shop' || name === 'docs' ? snapshot.split('\n').find(l => l.includes(`[ref=${ref}]`)) ?? null : null),
  },
  // solo1: only the owner · team1: two guests · anything else: never listed.
  calendar: { eventGuests: id => (id === 'solo1' ? 0 : id === 'team1' ? 2 : null) },
  sessionMode: id => (id === 'yolo-session' ? 'bypassPermissions' : id ? 'default' : null),
};
