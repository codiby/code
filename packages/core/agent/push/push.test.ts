import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'crypto';
import { classifyFcmError, createFcmClient, FCM_API_BASE } from './fcm';
import { buildFcmMessage, clip, isSilentNotify, type PushPayload } from './messages';
import { buildSignedJwt, createAccessTokenProvider, FCM_SCOPE, OAuthError, REFRESH_MARGIN_MS, TOKEN_URL, type FetchFn } from './oauth';
import { parseServiceAccount, ServiceAccountError, type ServiceAccount } from './serviceAccount';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const KEY_FILE = {
  type: 'service_account',
  project_id: 'codiby-push-test',
  private_key_id: 'kid0123456789',
  private_key: PEM,
  client_email: 'fcm-sender@codiby-push-test.iam.gserviceaccount.com',
  client_id: '1234567890',
};

const SA: ServiceAccount = parseServiceAccount(KEY_FILE);

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** A token endpoint that answers after `release()` — to observe concurrent callers. */
function gatedTokenFetch(opts: { expiresIn?: number; status?: number } = {}) {
  const calls: { url: string; body: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let n = 0;
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? '') });
    await gate;
    n++;
    if (opts.status && opts.status !== 200) {
      return Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: opts.status });
    }
    return Response.json({ access_token: `ya29.token-${n}`, expires_in: opts.expiresIn ?? 3600, token_type: 'Bearer' });
  };
  return { fetch, calls, release };
}

describe('service account', () => {
  test('accepts the downloaded JSON as object or text, with escaped newlines', () => {
    const fromText = parseServiceAccount(JSON.stringify({ ...KEY_FILE, private_key: PEM.replace(/\n/g, '\\n') }));
    expect(fromText.projectId).toBe('codiby-push-test');
    expect(fromText.privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    expect(fromText.privateKeyId).toBe('kid0123456789');
  });

  test('rejects anything that is not a usable service account, without quoting the key', () => {
    const bad: unknown[] = [
      'not json',
      [],
      { ...KEY_FILE, type: 'authorized_user' },
      { ...KEY_FILE, project_id: 'X' },
      { ...KEY_FILE, client_email: 'nope' },
      { ...KEY_FILE, private_key: 'abc' },
      { ...KEY_FILE, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' },
    ];
    for (const input of bad) {
      let error: unknown;
      try { parseServiceAccount(input); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(ServiceAccountError);
      expect(String((error as Error).message)).not.toContain('PRIVATE KEY');
    }
  });
});

describe('JWT assertion', () => {
  test('is RS256-signed by the service account key with the FCM claims', () => {
    const now = 1_700_000_000_000;
    const jwt = buildSignedJwt(SA, now);
    const [h, c, s] = jwt.split('.');
    expect(decodePart(h!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid0123456789' });
    expect(decodePart(c!)).toEqual({
      iss: KEY_FILE.client_email,
      sub: KEY_FILE.client_email,
      scope: FCM_SCOPE,
      aud: TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('access token cache', () => {
  test('concurrent callers share one token request', async () => {
    const t = gatedTokenFetch();
    const provider = createAccessTokenProvider({ fetch: t.fetch, now: () => 1_000 });
    const all = Promise.all([provider.get(SA), provider.get(SA), provider.get(SA)]);
    t.release();
    expect(await all).toEqual(['ya29.token-1', 'ya29.token-1', 'ya29.token-1']);
    expect(t.calls).toHaveLength(1);
    const form = new URLSearchParams(t.calls[0]!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')!.split('.')).toHaveLength(3);
  });

  test('reuses the token until five minutes before it expires', async () => {
    let clock = 0;
    const t = gatedTokenFetch({ expiresIn: 3600 });
    t.release();
    const provider = createAccessTokenProvider({ fetch: t.fetch, now: () => clock });
    expect(await provider.get(SA)).toBe('ya29.token-1');
    clock = 3600_000 - REFRESH_MARGIN_MS - 1;
    expect(await provider.get(SA)).toBe('ya29.token-1');
    clock = 3600_000 - REFRESH_MARGIN_MS + 1;
    expect(await provider.get(SA)).toBe('ya29.token-2');
    expect(t.calls).toHaveLength(2);
  });

  test('a replaced key never reuses the old token; invalidate forces a refresh', async () => {
    const t = gatedTokenFetch();
    t.release();
    const provider = createAccessTokenProvider({ fetch: t.fetch, now: () => 0 });
    const rotated: ServiceAccount = {
      ...SA,
      privateKeyId: 'other-key',
      privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    await provider.get(SA);
    await provider.get(rotated);
    expect(t.calls).toHaveLength(2);
    provider.invalidate();
    await provider.get(rotated);
    expect(t.calls).toHaveLength(3);
  });

  test('a rejected assertion fails every waiter and is retried on the next call', async () => {
    const t = gatedTokenFetch({ status: 400 });
    const provider = createAccessTokenProvider({ fetch: t.fetch, now: () => 0 });
    const a = provider.get(SA);
    const b = provider.get(SA);
    t.release();
    await expect(a).rejects.toBeInstanceOf(OAuthError);
    await expect(b).rejects.toThrow('invalid_grant');
    await expect(provider.get(SA)).rejects.toBeInstanceOf(OAuthError);
    expect(t.calls).toHaveLength(2);
  });
});

describe('FCM error classification', () => {
  const fcmError = (status: number, errorCode: string | null, message = 'boom', extra: object[] = []) => ({
    error: {
      code: status,
      message,
      status: errorCode === 'UNREGISTERED' ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
      details: [
        ...(errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : []),
        ...extra,
      ],
    },
  });

  test('dead tokens are the device’s fault, setup errors are not', () => {
    expect(classifyFcmError(404, fcmError(404, 'UNREGISTERED')).kind).toBe('token');
    expect(classifyFcmError(400, fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token')).kind).toBe('token');
    expect(classifyFcmError(400, fcmError(400, 'INVALID_ARGUMENT', 'Invalid value', [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] }])).kind).toBe('token');
    expect(classifyFcmError(400, fcmError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unknown name "foo"')).kind).toBe('payload');
    expect(classifyFcmError(403, fcmError(403, 'SENDER_ID_MISMATCH')).kind).toBe('config');
    expect(classifyFcmError(401, fcmError(401, 'THIRD_PARTY_AUTH_ERROR')).message).toContain('APNs');
    expect(classifyFcmError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'API disabled' } }).kind).toBe('config');
    expect(classifyFcmError(503, fcmError(503, 'UNAVAILABLE')).kind).toBe('transient');
    expect(classifyFcmError(429, fcmError(429, 'QUOTA_EXCEEDED')).kind).toBe('transient');
  });
});

describe('FCM client', () => {
  function fcmFetch(answers: (() => Response)[]) {
    const sends: { url: string; auth: string | null; body: any }[] = [];
    let tokens = 0;
    const fetch: FetchFn = async (url, init) => {
      if (url === TOKEN_URL) return Response.json({ access_token: `tok-${++tokens}`, expires_in: 3600 });
      const headers = new Headers(init?.headers);
      sends.push({ url, auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
      const next = answers.shift();
      return next ? next() : Response.json({ name: 'projects/codiby-push-test/messages/1' });
    };
    return { fetch, sends, tokenCount: () => tokens };
  }

  const message = { token: 'device-token-0123456789', data: { type: 'notify' } };

  test('posts the message to the project endpoint with the access token', async () => {
    const f = fcmFetch([]);
    const client = createFcmClient({ fetch: f.fetch, sleep: async () => {} });
    expect(await client.send(SA, message)).toEqual({ ok: true, messageId: 'projects/codiby-push-test/messages/1' });
    expect(f.sends[0]!.url).toBe(`${FCM_API_BASE}/codiby-push-test/messages:send`);
    expect(f.sends[0]!.auth).toBe('Bearer tok-1');
    expect(f.sends[0]!.body).toEqual({ message });
  });

  test('retries transient errors with backoff, then reports them', async () => {
    const slept: number[] = [];
    const unavailable = () => Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'try later' } }, { status: 503 });
    const f = fcmFetch([unavailable, unavailable, unavailable]);
    const client = createFcmClient({ fetch: f.fetch, sleep: async ms => { slept.push(ms); } });
    const outcome = await client.send(SA, message);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.kind).toBe('transient');
    expect(slept).toEqual([1_000, 4_000]);
    expect(f.sends).toHaveLength(3);
  });

  test('a 401 refreshes the access token once', async () => {
    const f = fcmFetch([() => Response.json({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'expired' } }, { status: 401 })]);
    const client = createFcmClient({ fetch: f.fetch, sleep: async () => {} });
    expect((await client.send(SA, message)).ok).toBe(true);
    expect(f.tokenCount()).toBe(2);
    expect(f.sends.map(s => s.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  test('UNREGISTERED is not retried', async () => {
    const f = fcmFetch([() => Response.json({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 })]);
    const client = createFcmClient({ fetch: f.fetch, sleep: async () => {} });
    const outcome = await client.send(SA, message);
    expect(!outcome.ok && outcome.kind).toBe('token');
    expect(f.sends).toHaveLength(1);
  });
});

describe('payloads', () => {
  const ctx = { host: 'ryzen9', now: 1_700_000_000_000 };

  test('approval: data-only for Android, alert with the APPROVAL category for iOS', () => {
    const payload: PushPayload = {
      type: 'approval',
      requestId: 'req-1',
      code: '4821',
      title: 'Bash',
      summary: 'rm -rf build',
      toolName: 'Bash',
      sessionId: 'main-session',
      sessionName: 'Codiby',
      expiresAt: ctx.now + 600_000,
    };
    const m = buildFcmMessage('tok', payload, ctx);
    expect(m.token).toBe('tok');
    expect(m.data).toEqual({
      host: 'ryzen9',
      sessionId: 'main-session',
      sessionName: 'Codiby',
      sentAt: String(ctx.now),
      type: 'approval',
      requestId: 'req-1',
      code: '4821',
      toolName: 'Bash',
      title: 'Approval needed · Codiby',
      body: 'Bash\nrm -rf build\nCode 4821',
      priority: 'urgent',
      channel: 'approvals',
      expiresAt: String(ctx.now + 600_000),
    });
    expect(Object.values(m.data).every(v => typeof v === 'string')).toBe(true);
    expect(m.android).toEqual({ priority: 'HIGH', ttl: '600s', collapse_key: 'req-1' });
    expect(m.apns!.headers).toEqual({
      'apns-priority': '10',
      'apns-push-type': 'alert',
      'apns-collapse-id': 'req-1',
      'apns-expiration': String(1_700_000_000 + 600),
    });
    expect(m.apns!.payload.aps).toMatchObject({
      alert: { title: 'Approval needed · Codiby', body: 'Bash\nrm -rf build\nCode 4821' },
      category: 'APPROVAL',
      'mutable-content': 1,
      'interruption-level': 'time-sensitive',
      sound: 'default',
    });
  });

  test('a question goes out without buttons', () => {
    const m = buildFcmMessage('tok', { type: 'approval', requestId: 'q-1', title: 'AskUserQuestion', summary: 'Which branch?', toolName: 'AskUserQuestion', sessionId: 's', sessionName: 'api' }, ctx);
    expect(m.data).toMatchObject({ type: 'approval', question: 'true', title: 'Question · api', body: 'Which branch?' });
    expect(m.apns!.payload.aps.category).toBeUndefined();
  });

  test('approval_resolved: silent, collapses onto its request', () => {
    const m = buildFcmMessage('tok', { type: 'approval_resolved', requestId: 'req-1', allow: true, via: 'telegram', sessionId: 's', sessionName: 'S' }, ctx);
    expect(m.data).toMatchObject({ type: 'approval_resolved', requestId: 'req-1', allow: 'true', via: 'telegram' });
    expect(m.android).toMatchObject({ priority: 'NORMAL', collapse_key: 'req-1' });
    expect(m.apns).toEqual({ headers: { 'apns-priority': '5', 'apns-push-type': 'background' }, payload: { aps: { 'content-available': 1 } } });
  });

  test('notify: quiet goes to the quiet channel without sound; urgent is high priority', () => {
    const base = { type: 'notify' as const, title: 'Reminder', text: 'Call Ana', sessionId: 'main-session', sessionName: 'Codiby' };
    const quiet = buildFcmMessage('tok', { ...base, priority: 'normal', quiet: true }, ctx);
    expect(quiet.data).toMatchObject({ type: 'notify', title: 'Reminder', body: 'Call Ana', quiet: 'true', channel: 'messages_quiet', priority: 'normal' });
    expect(quiet.android!.priority).toBe('NORMAL');
    expect(quiet.apns!.payload.aps.sound).toBeUndefined();
    expect(quiet.apns!.payload.aps['interruption-level']).toBe('passive');

    const urgent = buildFcmMessage('tok', { ...base, priority: 'urgent', quiet: true }, ctx);
    expect(urgent.data).toMatchObject({ quiet: 'false', channel: 'messages', priority: 'urgent' });
    expect(urgent.android!.priority).toBe('HIGH');
    expect(urgent.apns!.payload.aps).toMatchObject({ sound: 'default', 'interruption-level': 'time-sensitive' });
  });

  test("notify: priority 'low' is silent even outside quiet hours; normal rings", () => {
    const base = { type: 'notify' as const, text: 'FYI: the package shipped', sessionId: 'main-session', sessionName: 'Codiby' };
    const low = buildFcmMessage('tok', { ...base, priority: 'low', quiet: false }, ctx);
    expect(low.data).toMatchObject({ priority: 'low', quiet: 'true', channel: 'messages_quiet' });
    expect(low.android!.priority).toBe('NORMAL');
    expect(low.apns!.headers['apns-priority']).toBe('5');
    expect(low.apns!.payload.aps.sound).toBeUndefined();
    expect(low.apns!.payload.aps['interruption-level']).toBe('passive');

    const normal = buildFcmMessage('tok', { ...base, priority: 'normal', quiet: false }, ctx);
    expect(normal.data).toMatchObject({ priority: 'normal', quiet: 'false', channel: 'messages' });
    expect(normal.apns!.headers['apns-priority']).toBe('10');
    expect(normal.apns!.payload.aps).toMatchObject({ sound: 'default', 'interruption-level': 'active' });

    expect(isSilentNotify({ priority: 'low', quiet: false })).toBe(true);
    expect(isSilentNotify({ priority: 'normal', quiet: true })).toBe(true);
    expect(isSilentNotify({ priority: 'urgent', quiet: true })).toBe(false);
    expect(isSilentNotify({ priority: 'normal', quiet: false })).toBe(false);
  });

  test('a message reminder (no title, "⏰ …") is titled with the session and keeps its text', () => {
    // What proactive/reminders.ts deliverReminder raises for the agent session.
    const m = buildFcmMessage('tok', { type: 'notify', title: null, text: '⏰ Call Ana about the lease', priority: 'normal', sessionId: 'main-session', sessionName: '🤖 Codiby', quiet: false }, ctx);
    expect(m.data).toMatchObject({ title: '🤖 Codiby', body: '⏰ Call Ana about the lease', channel: 'messages' });
    expect(m.apns!.payload.aps.alert).toEqual({ title: '🤖 Codiby', body: '⏰ Call Ana about the lease' });
    // Blank session name and blank title still give the lock screen a title.
    const bare = buildFcmMessage('tok', { type: 'notify', title: '  ', text: '⏰ Water the plants', priority: 'low', sessionId: 'main-session', sessionName: ' ', quiet: false }, ctx);
    expect(bare.data).toMatchObject({ title: 'Codiby', body: '⏰ Water the plants', quiet: 'true' });
  });

  test('clipping never splits an emoji', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let max = 2; max < 12; max++) expect(lone.test(clip('⏰ 🎉🎉🎉🎉🎉🎉🎉🎉', max))).toBe(false);
    const text = `⏰ ${'🎂'.repeat(2000)}`;
    const m = buildFcmMessage('tok', { type: 'notify', text, priority: 'normal', sessionId: 's', sessionName: 'S', quiet: false }, ctx);
    expect(lone.test(m.data.body!)).toBe(false);
    expect(m.data.body!.startsWith('⏰ 🎂')).toBe(true);
    expect(m.data.body!.endsWith('…')).toBe(true);
  });

  test('long text is shrunk below the FCM size limit', () => {
    const text = '日本語のテキスト'.repeat(400);
    const m = buildFcmMessage('tok', { type: 'notify', text, priority: 'normal', sessionId: 's', sessionName: 'S', quiet: false }, ctx);
    expect(Buffer.byteLength(JSON.stringify({ data: m.data, apns: m.apns!.payload }))).toBeLessThan(4096);
    expect(m.data.body!.endsWith('…')).toBe(true);
  });
});
