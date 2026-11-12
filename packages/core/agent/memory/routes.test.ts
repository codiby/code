import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MAIN_SESSION_ID } from '../../config/config';
import { sqliteHandle } from '../../database';
import { loadAgentConfig, reloadAgentConfig, saveAgentConfig } from '../config';
import { listPromptSections } from '../registry';
import { handleAgentRoute } from '../routes';
import { executeAgentTool, listAgentToolsFor } from '../tools';
import { memorySettingsStore, memoryStateStore, normalizeMemorySettings, normalizeMemoryState } from './settings';
import { MEMORY_BANNER, MEMORY_TOOL_NAMES, PEOPLE_BANNER } from './tools';
import './index';

const ctx = { sessionId: MAIN_SESSION_ID, sessionName: 'Agent' };

async function call(method: string, path: string, body?: unknown, authenticated = true) {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = new Request(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const res = (await handleAgentRoute(req, url, authenticated))!;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function tool(name: string, args: Record<string, unknown>) {
  const res = await executeAgentTool(name, args, ctx);
  const text = (res.content[0] as { text: string }).text;
  return { isError: !!res.isError, text };
}

/** Tool results are an optional banner line followed by compact JSON. */
function payload(text: string): any {
  return JSON.parse(text.slice(text.indexOf('{')));
}

beforeAll(() => {
  saveAgentConfig({ ...loadAgentConfig(), enabled: true });
});

afterAll(() => {
  saveAgentConfig({ ...loadAgentConfig(), enabled: false });
  reloadAgentConfig();
});

beforeEach(() => {
  sqliteHandle.exec('DELETE FROM agent_memory; DELETE FROM agent_people;');
  memorySettingsStore.set(normalizeMemorySettings(null));
  memoryStateStore.set(normalizeMemoryState(null));
});

describe('memory tools', () => {
  test('are offered to the agent session only', () => {
    const forAgent = listAgentToolsFor(MAIN_SESSION_ID).map(t => t.name);
    for (const name of MEMORY_TOOL_NAMES) expect(forAgent).toContain(name);
    const forOthers = listAgentToolsFor('some-coding-session').map(t => t.name);
    for (const name of MEMORY_TOOL_NAMES) expect(forOthers).not.toContain(name);
    expect([...MEMORY_TOOL_NAMES].sort()).toEqual(['forget', 'people_find', 'people_list', 'people_upsert', 'recall', 'remember', 'update_profile']);
  });

  test('remember → recall → forget round trip', async () => {
    const saved = payload((await tool('remember', { content: 'Le gusta el café de olla', kind: 'preference', tags: ['cafe'] })).text);
    expect(saved).toMatchObject({ ok: true, status: 'saved', memory: { kind: 'preference', content: 'Le gusta el café de olla' } });
    const again = payload((await tool('remember', { content: 'le gusta el CAFE de olla' })).text);
    expect(again.status).toBe('already_known');

    const recall = await tool('recall', { query: 'cafe' });
    expect(recall.text.startsWith(MEMORY_BANNER)).toBe(true);
    const hits = payload(recall.text).results;
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(saved.memory.id);

    const candidates = payload((await tool('forget', { query: 'cafe' })).text);
    expect(candidates.deleted).toBe(false);
    expect(candidates.candidates[0].id).toBe(saved.memory.id);
    expect(payload((await tool('recall', { query: 'cafe' })).text).results).toHaveLength(1);

    const forgot = payload((await tool('forget', { id: saved.memory.id })).text);
    expect(forgot).toMatchObject({ ok: true, forgotten: { id: saved.memory.id } });
    expect(payload((await tool('recall', { query: 'cafe' })).text).results).toHaveLength(0);
  });

  test('errors come back as tool errors, not exceptions', async () => {
    expect((await tool('remember', { content: 'my password is Hunter2!' })).isError).toBe(true);
    expect((await tool('remember', {})).isError).toBe(true);
    expect((await tool('recall', { query: '' })).isError).toBe(true);
    expect((await tool('forget', { id: 'missing' })).isError).toBe(true);
    expect((await tool('people_upsert', { name: 'Ana', handles: { whatsapp: ['nope'] } })).isError).toBe(true);
  });

  test('update_profile and people tools', async () => {
    const prof = payload((await tool('update_profile', { facts: ['Vive en Culiacán', 'Trabaja como ingeniero'] })).text);
    expect(prof).toMatchObject({ ok: true, added: 2, removed: 0 });
    expect(prof.profile.map((p: { content: string }) => p.content)).toEqual(['Vive en Culiacán', 'Trabaja como ingeniero']);

    const ana = payload((await tool('people_upsert', { name: 'Ana López', aliases: ['esposita'], relation: 'esposa', handles: { whatsapp: ['6677805604'] } })).text);
    expect(ana).toMatchObject({ ok: true, status: 'created', person: { handles: { whatsapp: ['5216677805604@s.whatsapp.net'] } } });
    const found = await tool('people_find', { query: 'Esposita' });
    expect(found.text.startsWith(PEOPLE_BANNER)).toBe(true);
    expect(payload(found.text).results[0].id).toBe(ana.person.id);
    const list = payload((await tool('people_list', {})).text);
    expect(list.total).toBe(1);
  });

  test('the prompt section is registered at order 20 and shows what was saved', async () => {
    await tool('update_profile', { facts: ['Vive en Culiacán'] });
    await tool('people_upsert', { name: 'Ana López', aliases: ['esposita'], relation: 'esposa', handles: { whatsapp: ['6677805604'] } });
    const section = listPromptSections().find(s => s.id === 'memory')!;
    expect(section.order).toBe(20);
    const text = section.render({ id: MAIN_SESSION_ID } as never)!;
    expect(text).toContain('## What you know about the owner');
    expect(text).toContain('- Vive en Culiacán');
    expect(text).toContain('- Ana López (esposa) — aka esposita');
    expect(text).not.toContain('5216677805604');
    expect(text).toContain('Connections tab');
  });
});

describe('memory routes', () => {
  test('require auth', async () => {
    expect((await call('GET', '/agent/memory', undefined, false)).status).toBe(401);
    expect((await call('GET', '/agent/people', undefined, false)).status).toBe(401);
  });

  test('create, list, search, edit and delete memories', async () => {
    const created = await call('POST', '/agent/memory', { content: 'Prefers aisle seats', kind: 'preference', tags: 'travel, flights' });
    expect(created.status).toBe(201);
    expect(created.data.item).toMatchObject({ kind: 'preference', tags: ['travel', 'flights'], source: 'owner' });
    const id = created.data.item.id;

    expect((await call('POST', '/agent/memory', { content: 'prefers AISLE seats.' })).status).toBe(200);
    await call('POST', '/agent/memory', { content: 'Vive en Culiacán', kind: 'profile' });

    const all = await call('GET', '/agent/memory');
    expect(all.data.total).toBe(2);
    expect(all.data.counts).toMatchObject({ total: 2, preference: 1, profile: 1 });
    expect((await call('GET', '/agent/memory?kind=profile')).data.items).toHaveLength(1);
    expect((await call('GET', '/agent/memory?query=culiacan')).data.items[0].content).toBe('Vive en Culiacán');
    expect((await call('GET', '/agent/memory?query=' + encodeURIComponent('NEAR("x" y) content:*'))).status).toBe(200);
    expect((await call('GET', '/agent/memory?kind=gossip')).status).toBe(400);

    const edited = await call('PATCH', `/agent/memory/${id}`, { pinned: true, content: 'Prefers aisle seats on long flights' });
    expect(edited.data.item).toMatchObject({ pinned: true, content: 'Prefers aisle seats on long flights' });

    expect((await call('DELETE', `/agent/memory/${id}`)).data).toEqual({ ok: true });
    expect((await call('DELETE', `/agent/memory/${id}`)).status).toBe(404);
    expect((await call('PATCH', '/agent/memory/missing', { pinned: true })).status).toBe(404);
  });

  test('reject bad bodies and secrets', async () => {
    expect((await call('POST', '/agent/memory', '[1,2]')).status).toBe(400);
    expect((await call('POST', '/agent/memory', 'not json')).status).toBe(400);
    expect((await call('POST', '/agent/memory', { content: '' })).status).toBe(400);
    const secret = await call('POST', '/agent/memory', { content: 'PIN: 4821' });
    expect(secret.status).toBe(422);
    expect(secret.data.error).toContain('Connections');
  });

  test('people CRUD with replace semantics', async () => {
    const created = await call('POST', '/agent/people', { name: 'José Pérez', aliases: ['Pepe'], relation: 'brother', handles: { whatsapp: ['+52 667 780 5604'] } });
    expect(created.status).toBe(201);
    const id = created.data.person.id;
    expect((await call('GET', '/agent/people?query=pepe')).data.people[0].id).toBe(id);
    expect((await call('GET', '/agent/people')).data.people).toHaveLength(1);

    const edited = await call('PATCH', `/agent/people/${id}`, { aliases: [], handles: { email: ['pepe@example.com'] }, relation: '' });
    expect(edited.data.person).toMatchObject({ aliases: [], handles: { email: ['pepe@example.com'] }, relation: null, name: 'José Pérez' });
    expect((await call('PATCH', `/agent/people/${id}`, { handles: { whatsapp: ['abc'] } })).status).toBe(400);
    expect((await call('POST', '/agent/people', { name: '' })).status).toBe(400);

    expect((await call('DELETE', `/agent/people/${id}`)).data).toEqual({ ok: true });
    expect((await call('GET', '/agent/people')).data.people).toHaveLength(0);
  });

  test('settings round trip and validation', async () => {
    const initial = await call('GET', '/agent/memory/settings');
    expect(initial.data.settings).toEqual({ dailyRotation: { enabled: true, time: '04:00' }, consolidateOnRotate: true });
    expect(initial.data.state).toMatchObject({ rotating: false, lastRotatedAt: null });

    const saved = await call('PUT', '/agent/memory/settings', { dailyRotation: { time: '05:30' }, consolidateOnRotate: false });
    expect(saved.data.settings).toEqual({ dailyRotation: { enabled: true, time: '05:30' }, consolidateOnRotate: false });
    // Moving the time starts counting from the next slot instead of rotating on the spot.
    expect(memoryStateStore.get().lastDailySlot).not.toBeNull();
    expect(saved.data.state.nextAt).toBeGreaterThan(Date.now());

    expect((await call('PUT', '/agent/memory/settings', { dailyRotation: { time: '25:00' } })).status).toBe(400);
    expect((await call('PUT', '/agent/memory/settings', { dailyRotation: { enabled: 'yes' } })).status).toBe(400);
    expect((await call('PUT', '/agent/memory/settings', { dailyRotation: 'daily' })).status).toBe(400);
  });

  test('rotate refuses while the agent is off', async () => {
    saveAgentConfig({ ...loadAgentConfig(), enabled: false });
    try {
      const res = await call('POST', '/agent/memory/rotate');
      expect(res.status).toBe(409);
    } finally {
      saveAgentConfig({ ...loadAgentConfig(), enabled: true });
    }
  });
});
