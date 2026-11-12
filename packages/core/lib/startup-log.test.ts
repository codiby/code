import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { MASKED_TOKEN, mobileUrlLogLine, startupLogLines } from './startup-log';

const info = {
  scheme: 'http' as const,
  port: 3111,
  host: '0.0.0.0',
  tls: false,
  claudeBin: '/usr/local/bin/claude',
  cwd: '/Users/owner/src',
  spawnMode: 'service',
  lanIp: '192.168.1.20',
};

describe('startup log', () => {
  test('the mobile URL carries a masked token and points to pairing', () => {
    const line = mobileUrlLogLine('https', '192.168.1.20', 3111);
    expect(line).toBe(`Mobile URL: https://192.168.1.20:3111/m#t=${MASKED_TOKEN} (open Settings → Mobile Pairing to pair)`);
    // Only the mask follows `#t=`: no hex token can sneak in.
    expect(line).not.toMatch(/#t=[0-9a-f]{8,}/i);
  });

  test('no LAN IP gives the hint instead of a URL', () => {
    expect(mobileUrlLogLine('http', '127.0.0.1', 3111)).toContain('no LAN IP detected');
    expect(mobileUrlLogLine('http', null, 3111)).toContain('no LAN IP detected');
  });

  test('every startup line is free of token-shaped values', () => {
    const lines = startupLogLines(info);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line).not.toMatch(/[0-9a-f]{32,}/i);
    expect(lines.at(-1)).toContain(MASKED_TOKEN);
  });

  test('index.ts logs the startup lines through the masking helper', () => {
    // Guards against the raw token coming back in a later edit of the
    // startup block: the token getter must never be interpolated into a log.
    const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('startupLogLines(');
    expect(src).not.toMatch(/log\([^)]*loadOrCreateMobileToken\(\)/);
    expect(src).not.toMatch(/log\(`[^`]*\$\{[^}]*loadOrCreateMobileToken/);
  });
});
