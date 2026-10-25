import {
  directHandoff,
  directMessageText,
  directPrompt,
  loadDirectContext,
  parseDirectRecommendation,
  type DirectContext,
} from '../src/api/directChat';
import { createSession, parseSessionList } from '../src/api/sessions';
import type { ChatMessage, SessionSummary } from '../src/api/types';

const session = (serverId: string, cwd: string): SessionSummary => ({
  id: 'same-id',
  key: `${serverId}:same-id`,
  serverId,
  cwd,
  name: 'Navegación',
  folder: 'app',
  updatedAt: 1,
  isOpen: true,
  isRunning: false,
  provider: 'claude',
});
const context: DirectContext = {
  sessions: [session('a', '/a/app'), session('b', '/b/app')],
  hosts: [
    {
      id: 'a',
      name: 'Studio',
      home: '/a',
      baseUrl: 'http://a',
      token: 'secret-a',
    },
    {
      id: 'b',
      name: 'Laptop',
      home: '/b',
      baseUrl: 'http://b',
      token: 'secret-b',
    },
  ],
  failed: [],
  excerpts: [],
};
const block = (value: unknown) =>
  'Mi propuesta.\n```codiby-route\n' + JSON.stringify(value) + '\n```';
const msg = (
  content: string,
  role: ChatMessage['role'] = 'user',
): ChatMessage => ({
  id: content,
  seq: 1,
  role,
  content,
  images: [],
  timestamp: 0,
  toolName: null,
  toolInput: null,
  isThinking: false,
  thinkingRedacted: false,
});

afterEach(() => jest.restoreAllMocks());

test('IDs iguales en hosts distintos resuelven a la sesión del host correcto', () => {
  const route = parseDirectRecommendation(
    block({
      kind: 'continue',
      serverId: 'b',
      sessionId: 'same-id',
      reason: 'Contexto útil',
    }),
    context,
  );
  expect(route?.kind === 'continue' && route.session.key).toBe('b:same-id');
});

test('rechaza destinos inventados, caídos o sesiones desechables', () => {
  const proposal = block({
    kind: 'continue',
    serverId: 'b',
    sessionId: 'same-id',
    reason: 'Contexto útil',
  });
  expect(
    parseDirectRecommendation(proposal, { ...context, failed: ['b'] }),
  ).toBeNull();
  expect(
    parseDirectRecommendation(proposal, { ...context, sessions: [] }),
  ).toBeNull();
  expect(
    parseDirectRecommendation(proposal, {
      ...context,
      sessions: context.sessions.map(s => ({ ...s, disposableTtlMs: 3600000 })),
    }),
  ).toBeNull();
});

test('solo propone crear en carpetas conocidas del host elegido o en su home', () => {
  const proposal = (cwd: string) =>
    block({
      kind: 'new',
      serverId: 'b',
      cwd,
      title: 'Nuevo proyecto',
      reason: 'Otro tema',
    });
  expect(parseDirectRecommendation(proposal('/b/app'), context)?.kind).toBe(
    'new',
  );
  expect(parseDirectRecommendation(proposal('/b'), context)?.kind).toBe('new');
  expect(parseDirectRecommendation(proposal('/a/app'), context)).toBeNull();
  expect(parseDirectRecommendation(proposal('/inventado'), context)).toBeNull();
});

test('respuestas incompletas o de forma incorrecta no crean acciones', () => {
  for (const text of [
    'hola',
    '```codiby-route\n{',
    block(null),
    block({ kind: 'new' }),
  ]) {
    expect(parseDirectRecommendation(text, context)).toBeNull();
  }
});

test('el contexto del agente omite credenciales y el mensaje visible conserva la petición', () => {
  const prompt = directPrompt('Quiero rediseñar la navegación', context);
  expect(prompt).toContain('/b/app');
  expect(prompt).not.toContain('secret-a');
  expect(prompt).not.toContain('secret-b');
  expect(prompt).not.toContain('http://a');
  expect(directMessageText(prompt)).toBe('Quiero rediseñar la navegación');
  expect(directMessageText('Respuesta.\n```codiby-route\n{"kind":')).toBe(
    'Respuesta.',
  );
});

test('la transferencia conserva peticiones y adjuntos, omite instrucciones internas y envíos fallidos', () => {
  const image = { mediaType: 'image/png', data: 'abc' };
  const handoff = directHandoff([
    { ...msg(directPrompt('Primera petición', context)), images: [image] },
    msg('Respuesta del agente', 'assistant'),
    msg('Segunda petición'),
    { ...msg('No se envió'), sendState: 'failed' },
  ]);
  expect(handoff).toEqual({
    text: 'Primera petición\n\nSegunda petición',
    images: [image],
  });
});

test('crea una sesión con TTL desechable y reconoce el TTL al recibirla', async () => {
  const response = {
    id: 'new',
    name: 'Chat directo',
    cwd: '/a',
    disposable_ttl_ms: 3600000,
  };
  const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response,
  } as Response);
  const created = await createSession('http://a', 'secret', 'a', {
    cwd: '/a',
    name: 'Chat directo',
    provider: 'claude',
    model: null,
    disposableTtlMs: 3600000,
  });
  expect(
    JSON.parse(fetcher.mock.calls[0]![1]!.body as string).disposable_ttl_ms,
  ).toBe(3600000);
  expect(created.disposableTtlMs).toBe(3600000);
  expect(parseSessionList([response], 'a')[0]?.disposableTtlMs).toBe(3600000);
});

test('consulta ambos hosts y conserva resultados cuando uno no responde', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url.startsWith('http://b')) {
      throw new Error('offline');
    }
    const json = url.endsWith('/sessions')
      ? [
          { id: 'same-id', name: 'App', cwd: '/a/app', status: 'open' },
          { id: 'temp', name: 'Chat directo', disposable_ttl_ms: 3600000 },
        ]
      : url.endsWith('/user-home')
      ? { home: '/a' }
      : { messages: [], hasMore: false };
    return { ok: true, status: 200, json: async () => json } as Response;
  });
  const loaded = await loadDirectContext(context.hosts, 'App');
  expect(loaded.failed).toEqual(['b']);
  expect(loaded.sessions.map(s => s.key)).toEqual(['a:same-id']);
  expect(loaded.excerpts).toHaveLength(1);
});
