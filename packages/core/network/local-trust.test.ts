import { describe, expect, test } from 'bun:test';
import {
  callerInput,
  isLocalOrigin,
  isLocalUiRequest,
  isLocalhostRequest,
  isLoopbackHost,
  isLoopbackOrigin,
  isOwnerVerifiedRequest,
  isProxiedRequest,
  presentsToken,
  type CallerInput,
} from './local-trust';

const TOKEN = 'a'.repeat(64);

/** A request as the bridge sees it: headers + the socket's peer. */
function caller(headers: Record<string, string>, peer: string | null = '127.0.0.1', path = '/agent/config'): CallerInput {
  const url = new URL(`http://localhost:3111${path}`);
  return callerInput(new Request(url, { headers }), url, peer);
}

describe('isLoopbackHost', () => {
  test('loopback names with and without a port', () => {
    for (const h of ['localhost', 'localhost:3111', 'LOCALHOST:3111', '127.0.0.1', '127.0.0.1:3111', '127.1.2.3:80', '[::1]', '[::1]:3111', '::1']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  test('anything else, including DNS-rebinding names and malformed brackets', () => {
    for (const h of ['evil.example', 'evil.example:3111', 'localhost.evil.example', '192.168.1.20:3111', 'machine.tailnet.ts.net', '[::1', '[fe80::1]:3111', '', '0.0.0.0:3111']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('origins', () => {
  test('an absent Origin is local (CLI, native apps), a present one must be loopback http(s)', () => {
    expect(isLocalOrigin(null)).toBe(true);
    expect(isLocalOrigin('')).toBe(true);
    expect(isLocalOrigin('http://localhost:3111')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isLocalOrigin('http://[::1]:3111')).toBe(true);
    expect(isLocalOrigin('https://evil.example')).toBe(false);
    expect(isLocalOrigin('null')).toBe(false); // sandboxed iframe, file://
    expect(isLocalOrigin('chrome-extension://abc')).toBe(false);
  });

  test('isLoopbackOrigin requires one to be present', () => {
    expect(isLoopbackOrigin(null)).toBe(false);
    expect(isLoopbackOrigin('http://localhost:3111')).toBe(true);
  });
});

describe('isProxiedRequest', () => {
  test('reverse-proxy headers mark a relayed request', () => {
    for (const h of ['X-Forwarded-For', 'x-forwarded-host', 'X-Real-IP', 'Forwarded', 'Tailscale-Funnel-Request']) {
      expect(isProxiedRequest(new Headers({ [h]: '1' }))).toBe(true);
    }
    expect(isProxiedRequest(new Headers({ host: 'localhost' }))).toBe(false);
  });
});

describe('isLocalhostRequest', () => {
  test('the desktop app: loopback Host, peer and Origin', () => {
    expect(isLocalhostRequest(caller({ host: 'localhost:3111', origin: 'http://localhost:3111' }))).toBe(true);
    expect(isLocalhostRequest(caller({ host: 'localhost:3111' }))).toBe(true); // a CLI on this machine
    expect(isLocalhostRequest(caller({ host: 'localhost:3111' }, '::ffff:127.0.0.1'))).toBe(true);
  });

  test('a laptop UI through an SSH tunnel to this bridge', () => {
    // sshd connects from loopback; the page is the laptop's own local UI.
    expect(isLocalhostRequest(caller({ host: '127.0.0.1:52011', origin: 'http://localhost:3111' }))).toBe(true);
  });

  test('a LAN client faking Host: localhost', () => {
    expect(isLocalhostRequest(caller({ host: 'localhost:3111' }, '192.168.1.24'))).toBe(false);
    expect(isLocalhostRequest(caller({ host: 'localhost:3111' }, null))).toBe(false);
  });

  test('DNS rebinding: loopback socket, foreign Host', () => {
    expect(isLocalhostRequest(caller({ host: 'evil.example:3111', origin: 'http://evil.example:3111' }))).toBe(false);
  });

  test('a website in the owner browser calling localhost', () => {
    expect(isLocalhostRequest(caller({ host: 'localhost:3111', origin: 'https://evil.example' }))).toBe(false);
  });

  test('a local reverse proxy (Funnel, ngrok) relaying the internet, even with Host rewritten', () => {
    expect(isLocalhostRequest(caller({ host: 'localhost:3111', 'x-forwarded-for': '203.0.113.7' }))).toBe(false);
    expect(isLocalhostRequest(caller({ host: 'localhost:3111', 'tailscale-funnel-request': '?1' }))).toBe(false);
  });
});

describe('isLocalUiRequest', () => {
  test('a page sends Origin on mutations and cross-origin calls, Sec-Fetch-Site on same-origin GETs', () => {
    expect(isLocalUiRequest('http://localhost:3111', null)).toBe(true);
    expect(isLocalUiRequest(null, 'same-origin')).toBe(true);
  });

  test('a CLI sends neither; a foreign page is not ours', () => {
    expect(isLocalUiRequest(null, null)).toBe(false);
    expect(isLocalUiRequest(null, 'none')).toBe(false); // typed in the address bar
    expect(isLocalUiRequest(null, 'cross-site')).toBe(false);
    expect(isLocalUiRequest('https://evil.example', 'cross-site')).toBe(false);
  });
});

describe('presentsToken', () => {
  const none = { authorization: null, queryToken: null, wsProtocol: null };

  test('accepts the token as bearer, ?t= or WebSocket protocol', () => {
    expect(presentsToken({ ...none, authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
    expect(presentsToken({ ...none, authorization: `bearer  ${TOKEN} ` }, TOKEN)).toBe(true);
    expect(presentsToken({ ...none, queryToken: TOKEN }, TOKEN)).toBe(true);
    expect(presentsToken({ ...none, wsProtocol: `json, ${TOKEN}` }, TOKEN)).toBe(true);
  });

  test('rejects wrong, partial or empty tokens', () => {
    expect(presentsToken(none, TOKEN)).toBe(false);
    expect(presentsToken({ ...none, authorization: `Bearer ${TOKEN.slice(1)}` }, TOKEN)).toBe(false);
    expect(presentsToken({ ...none, authorization: TOKEN }, TOKEN)).toBe(false); // no "Bearer"
    expect(presentsToken({ ...none, queryToken: '' }, '')).toBe(false);
    expect(presentsToken({ ...none, wsProtocol: 'json' }, TOKEN)).toBe(false);
  });
});

describe('isOwnerVerifiedRequest', () => {
  test('the desktop UI on this machine', () => {
    expect(isOwnerVerifiedRequest(caller({ host: 'localhost:3111', origin: 'http://localhost:3111' }), TOKEN)).toBe(true);
    expect(isOwnerVerifiedRequest(caller({ host: 'localhost:3111', 'sec-fetch-site': 'same-origin' }), TOKEN)).toBe(true);
  });

  test('a remote UI through a tunnel (its Origin is the laptop local UI)', () => {
    expect(isOwnerVerifiedRequest(caller({ host: '127.0.0.1:52011', origin: 'http://localhost:3111' }), TOKEN)).toBe(true);
  });

  test('a phone or LAN browser with the token', () => {
    expect(isOwnerVerifiedRequest(caller({ host: '192.168.1.5:3111', authorization: `Bearer ${TOKEN}` }, '192.168.1.24'), TOKEN)).toBe(true);
    expect(isOwnerVerifiedRequest(caller({ host: 'localhost:3111' }, '127.0.0.1', `/agent/config?t=${TOKEN}`), TOKEN)).toBe(true);
  });

  test('curl from the agent Bash: localhost-trusted, not owner-verified', () => {
    const curl = caller({ host: 'localhost:3111', 'user-agent': 'curl/8.7.1' });
    expect(isLocalhostRequest(curl)).toBe(true);
    expect(isOwnerVerifiedRequest(curl, TOKEN)).toBe(false);
  });

  test('a loopback Origin on a non-local socket earns nothing without the token', () => {
    expect(isOwnerVerifiedRequest(caller({ host: 'localhost:3111', origin: 'http://localhost:3111' }, '192.168.1.24'), TOKEN)).toBe(false);
  });

  test('a proxied request needs the token even with a loopback Origin', () => {
    expect(isOwnerVerifiedRequest(caller({ host: 'localhost:3111', origin: 'http://localhost:3111', 'x-forwarded-for': '203.0.113.7' }), TOKEN)).toBe(false);
  });
});
