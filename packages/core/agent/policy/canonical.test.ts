/**
 * Address and path spellings are compared in canonical form: a URL is parsed
 * the way a browser parses it, and a glob is checked against what it can
 * expand to. Representative forms only — the point is that the check works on
 * the parsed value, not on the text.
 */

import { describe, expect, test } from 'bun:test';
import { categoryKeys, classifyToolCall } from './classify';
import { isLocalHostname } from './bridge-access';
import { ctx, HOME } from './test-context';

function key(toolName: string, input: Record<string, unknown>): string {
  const keys = categoryKeys(classifyToolCall(toolName, input, ctx));
  return keys[keys.length - 1]!;
}
const bash = (command: string) => key('Bash', { command });

describe('canonical addresses', () => {
  test('loopback is recognised from the parsed hostname', () => {
    for (const h of ['localhost', 'localhost.', 'app.localhost', '127.0.0.1', '127.9.9.9', '0.0.0.0', '[::1]', '::1', '[::]', '[::ffff:7f00:1]', '::ffff:127.0.0.1']) {
      expect(isLocalHostname(h)).toBe(true);
    }
    for (const h of ['api.github.com', '10.0.0.5', '192.168.1.20', '[2001:db8::1]', 'localhost.example.com']) {
      expect(isLocalHostname(h)).toBe(false);
    }
  });

  test('other spellings of this bridge are the bridge', () => {
    expect(bash('curl -s http://0177.0.0.1:3111/agent/config')).toBe('credentials:agent_vault');
    expect(bash('curl -s http://0x7f.0.0.1:3111/sessions')).toBe('network:bridge');
    expect(bash('curl -s http://localhost:03111/sessions')).toBe('network:bridge');
    expect(bash('curl -s "http://[::ffff:7f00:1]:3111/mobile/pair"')).toBe('credentials:agent_vault');
    expect(bash('curl -s 0x7f000001:3111/health')).toBe('network:bridge');
    expect(key('WebFetch', { url: 'http://017700000001:3111/agent/secrets', prompt: 'x' })).toBe('credentials:agent_vault');
  });

  test('an address the shell computes is not trusted', () => {
    expect(bash('curl -s "http://localhost:$((3000+111))/health"')).toBe('network:bridge');
    expect(bash('H=127.0.0.1; curl -s "http://$H:3111/health"')).toBe('network:bridge');
    expect(bash('curl -s "http://127.0.0.1:`cat port`/health"')).toBe('network:bridge');
  });

  test('ordinary commands keep their verdicts', () => {
    expect(bash('curl -s https://api.github.com/repos/codiby/code')).toBe('shell:read_only');
    expect(bash('git status')).toBe('shell:read_only');
    expect(bash('ls -la')).toBe('shell:read_only');
    expect(bash('cat README.md')).toBe('shell:read_only');
    expect(bash('echo 3111')).toBe('shell:read_only');
  });
});

describe('glob paths', () => {
  test('a glob that can name a secret file counts as that file', () => {
    expect(bash('cat ~/.codiby/ui-mob*')).toBe('credentials:agent_vault');
    expect(bash('cat ~/.codiby/ui-mobile-tok?n')).toBe('credentials:agent_vault');
    expect(bash('cat ~/.cod*/agent/vault.json')).toBe('credentials:agent_vault');
    expect(bash('cat ~/.{codiby,x}/ui-mobile-token')).toBe('credentials:agent_vault');
    expect(bash('cat ~/.claude/.cred*')).toBe('credentials:agent_vault');
    expect(key('Read', { file_path: `${HOME}/.wacli/conf*.json` })).toBe('credentials:agent_vault');
  });

  test('a glob into a home dot-folder asks; globs elsewhere are fine', () => {
    expect(bash('cat ~/.config/*/settings.json')).toMatch(/^credentials/);
    expect(bash('ls ~/agent/*.md')).toBe('shell:read_only');
    expect(bash('ls *.ts')).toBe('shell:read_only');
  });
});
