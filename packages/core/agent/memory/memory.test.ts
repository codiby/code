import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { sqliteHandle } from '../../database';
import { ensureMemorySearchIndex } from '../../database/memory-fts';
import * as uiMemory from '../../../ui/src/lib/agent/memory';
import { MemoryError } from './errors';
import * as memoryIndex from './index';
import {
  _resetMemoryIndexCheck,
  addMemory,
  findDuplicate,
  forgetMemory,
  getMemory,
  listMemories,
  promptMemories,
  searchMemories,
  updateMemory,
  updateProfile,
  type MemoryItem,
} from './memories';
import { findPeople, findPersonByHandle, normalizeHandles, upsertPerson, createPerson } from './people';
import { normalizePhone, normalizeWhatsAppHandle, phoneToWhatsAppJid } from './phone';
import { detectSecret } from './secrets';
import { OWNER_KNOWLEDGE_BUDGET, renderOwnerKnowledge, renderPeople } from './section';
import { buildFtsQuery, dedupKey, foldText } from './text';

function wipe() {
  sqliteHandle.exec('DELETE FROM agent_memory; DELETE FROM agent_people;');
}

function contents(items: MemoryItem[]): string[] {
  return items.map(i => i.content);
}

function expectMemoryError(fn: () => unknown, code: MemoryError['code']) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MemoryError);
    expect((err as MemoryError).code).toBe(code);
    return;
  }
  throw new Error(`expected a MemoryError(${code})`);
}

beforeEach(wipe);

describe('text folding', () => {
  test('folds case, accents and whitespace', () => {
    expect(foldText('  Café   de OLLA  ')).toBe('cafe de olla');
    expect(foldText('Niño — Ñoño')).toBe('nino — nono');
    expect(dedupKey('Likes coffee.')).toBe(dedupKey('  likes   COFFEE '));
  });
});

describe('memory search', () => {
  beforeEach(() => {
    addMemory({ content: 'Le gusta el café de olla sin azúcar', kind: 'preference', tags: ['bebidas'] });
    addMemory({ content: 'Su esposa se llama Ana y cumple años el 3 de junio', kind: 'person' });
    addMemory({ content: 'Vive en Culiacán, Sinaloa', kind: 'profile' });
    addMemory({ content: 'Prefers short answers, no preamble', kind: 'preference' });
    addMemory({ content: 'Su hijo juega fútbol los sábados en la mañana', kind: 'fact' });
    addMemory({ content: '☕ = the espresso machine at the office', kind: 'note' });
  });

  test('ignores accents both ways and matches prefixes', () => {
    expect(contents(searchMemories({ query: 'cafe' }))).toEqual(['Le gusta el café de olla sin azúcar']);
    expect(contents(searchMemories({ query: 'CULIACAN' }))).toEqual(['Vive en Culiacán, Sinaloa']);
    expect(contents(searchMemories({ query: 'futból sabado' }))).toEqual(['Su hijo juega fútbol los sábados en la mañana']);
    // "azu" is a prefix of "azúcar"
    expect(contents(searchMemories({ query: 'azu' }))).toEqual(['Le gusta el café de olla sin azúcar']);
  });

  test('Spanish questions search their meaningful words, best match first', () => {
    const hits = contents(searchMemories({ query: '¿Cómo se llama mi esposa?' }));
    expect(hits[0]).toBe('Su esposa se llama Ana y cumple años el 3 de junio');
  });

  test('any word can match; rows matching more words rank higher', () => {
    const hits = contents(searchMemories({ query: 'esposa olla', limit: 10 }));
    expect(hits).toHaveLength(2);
    expect(hits).toContain('Le gusta el café de olla sin azúcar');
  });

  test('tags are searchable and kind filters', () => {
    expect(contents(searchMemories({ query: 'bebidas' }))).toEqual(['Le gusta el café de olla sin azúcar']);
    expect(searchMemories({ query: 'su', kind: 'profile' }).every(i => i.kind === 'profile')).toBe(true);
    expect(contents(searchMemories({ query: '', kind: 'profile' }))).toEqual(['Vive en Culiacán, Sinaloa']);
  });

  test('queries without words fall back to LIKE', () => {
    expect(contents(searchMemories({ query: '☕' }))).toEqual(['☕ = the espresso machine at the office']);
    expect(searchMemories({ query: '%' })).toEqual([]);
  });

  test('FTS syntax in the query is searched as plain words, never executed', () => {
    const attacks = [
      '"', '""', '"cafe', 'cafe"', '*', 'cafe*', '^cafe', 'content:cafe', 'tags:bebidas', '{content tags}:cafe',
      'NEAR(cafe olla)', 'NEAR(cafe olla, 2)', 'cafe AND', 'OR', 'NOT cafe', 'cafe NOT olla', '-cafe', '+cafe',
      '(cafe', 'cafe)', 'agent_memory_fts:cafe', "cafe'; DROP TABLE agent_memory; --", '\\', ':', 'rank:1',
    ];
    for (const q of attacks) {
      const expr = buildFtsQuery(q);
      if (expr) expect(expr).toMatch(/^"[\p{L}\p{N}]+"\*?( OR "[\p{L}\p{N}]+"\*?)*$/u);
      expect(() => searchMemories({ query: q })).not.toThrow();
    }
    // Operators and column names are just words: "content:cafe" still finds the coffee.
    expect(contents(searchMemories({ query: 'content:cafe' }))).toContain('Le gusta el café de olla sin azúcar');
    expect(contents(searchMemories({ query: 'NEAR(cafe olla)' }))[0]).toBe('Le gusta el café de olla sin azúcar');
    expect(listMemories().total).toBe(6);
  });

  test('recall marks hits as used; browsing does not', () => {
    const [hit] = searchMemories({ query: 'culiacan' });
    expect(hit!.lastUsedAt).toBeNull();
    searchMemories({ query: 'culiacan', touch: true });
    expect(getMemory(hit!.id)!.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('dedup', () => {
  test('exact duplicates merge instead of piling up', () => {
    const a = addMemory({ content: 'Likes coffee.', tags: ['drinks'] });
    const b = addMemory({ content: '  likes   COFFEE ', tags: 'morning', pinned: true });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.tags).toEqual(['drinks', 'morning']);
    expect(b.item.pinned).toBe(true);
    expect(listMemories().total).toBe(1);
  });

  test('accents and case do not make a new memory', () => {
    const a = addMemory({ content: 'Le gusta el café' });
    const b = addMemory({ content: 'le gusta el cafe', kind: 'preference' });
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.kind).toBe('preference'); // an explicit kind reclassifies
  });

  test('similar but different facts are both kept', () => {
    addMemory({ content: 'Likes coffee' });
    expect(addMemory({ content: 'Likes coffee with milk' }).created).toBe(true);
    expect(findDuplicate('likes coffee with MILK!')).not.toBeNull();
  });

  test('editing into a duplicate is a conflict', () => {
    addMemory({ content: 'Likes tea' });
    const b = addMemory({ content: 'Likes mate' });
    expectMemoryError(() => updateMemory(b.item.id, { content: 'likes TEA' }), 'conflict');
  });
});

describe('without the search index (a SQLite built without FTS5)', () => {
  // What database/memory-fts.ts leaves behind on such a build: no table and no triggers.
  const dropIndex = () => sqliteHandle.exec(`
    DROP TRIGGER IF EXISTS agent_memory_ai; DROP TRIGGER IF EXISTS agent_memory_ad; DROP TRIGGER IF EXISTS agent_memory_au;
    DROP TABLE IF EXISTS agent_memory_fts;
  `);

  afterEach(() => {
    // Every later suite in this process shares the database: put the index back.
    ensureMemorySearchIndex(sqliteHandle);
    sqliteHandle.exec(`INSERT INTO agent_memory_fts(agent_memory_fts) VALUES('rebuild')`);
    _resetMemoryIndexCheck();
  });

  test('remember still saves and dedupes, recall still finds, and the failure is logged once', () => {
    dropIndex();
    _resetMemoryIndexCheck();
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const a = addMemory({ content: 'Le gusta el café de olla', kind: 'preference' });
      expect(a.created).toBe(true);
      expect(addMemory({ content: 'le gusta el CAFE de olla' }).created).toBe(false);
      expect(addMemory({ content: 'Juega pádel los martes' }).created).toBe(true);
      expect(findDuplicate('juega padel los martes!')).not.toBeNull();
      expect(contents(searchMemories({ query: 'pádel' }))).toEqual(['Juega pádel los martes']);
      expect(searchMemories({ query: 'olla' })).toHaveLength(1);
      expect(listMemories().total).toBe(2);
      const logged = errors.mock.calls.map(c => String(c[0])).filter(l => l.includes('[agent:memory]'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('plain text matching');
    } finally {
      errors.mockRestore();
    }
  });
});

describe('soft delete', () => {
  test('forgotten memories disappear from search and lists but stay in the table', () => {
    const { item } = addMemory({ content: 'Parks on level 3 at work' });
    forgetMemory(item.id);
    expect(getMemory(item.id)).toBeNull();
    expect(searchMemories({ query: 'parks level' })).toEqual([]);
    expect(listMemories().total).toBe(0);
    const row = sqliteHandle.query('SELECT deleted_at FROM agent_memory WHERE id = ?').get(item.id) as { deleted_at: number };
    expect(row.deleted_at).toBeGreaterThan(0);
    expectMemoryError(() => forgetMemory(item.id), 'not_found');
    // Saying it again creates a fresh memory instead of resurrecting the old row.
    expect(addMemory({ content: 'Parks on level 3 at work' }).created).toBe(true);
  });
});

describe('validation and secrets', () => {
  test('rejects bad input', () => {
    expectMemoryError(() => addMemory({ content: '   ' }), 'invalid');
    expectMemoryError(() => addMemory({ content: 42 }), 'invalid');
    expectMemoryError(() => addMemory({ content: 'x', kind: 'gossip' }), 'invalid');
    expectMemoryError(() => addMemory({ content: 'x'.repeat(2001) }), 'invalid');
    expectMemoryError(() => addMemory({ content: 'x', pinned: 'yes' }), 'invalid');
  });

  test('refuses secrets and points to the vault', () => {
    for (const s of [
      'My bank password is Hunter2!',
      'contraseña: perro123',
      'El NIP de la tarjeta es 4821',
      'wifi password = "sunshine"',
      'password for gmail: abc123',
      'api key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'Card 4111 1111 1111 1111 exp 12/29',
    ]) {
      expect(detectSecret(s)).not.toBeNull();
      expectMemoryError(() => addMemory({ content: s }), 'secret');
    }
    try { addMemory({ content: 'password: hunter22' }); } catch (err) { expect((err as Error).message).toContain('Connections'); }
  });

  test('ordinary facts that mention passwords still save', () => {
    for (const s of [
      'Changes his passwords every month',
      'The token is valid until May',
      'La contraseña es única para cada banco',
      'His WhatsApp is 5216677805604',
      'Uses 1Password for everything',
      'Token rotation: weekly',
      'pin is in the drawer',
    ]) {
      expect(detectSecret(s)).toBeNull();
    }
  });
});

describe('profile', () => {
  test('adds, skips known facts, removes and replaces', () => {
    const first = updateProfile({ facts: ['Lives in Culiacán', 'Works as an engineer'] });
    expect(first.added).toBe(2);
    const again = updateProfile({ facts: ['lives in culiacan', 'Has two kids'] });
    expect(again).toMatchObject({ added: 1, alreadyKnown: 1, removed: 0 });
    const culiacan = again.profile.find(p => p.content === 'Lives in Culiacán')!;
    const moved = updateProfile({ facts: ['Lives in Mazatlán'], remove: [culiacan.id] });
    expect(contents(moved.profile)).toEqual(['Works as an engineer', 'Has two kids', 'Lives in Mazatlán']);
    const replaced = updateProfile({ facts: ['Lives in Mazatlán'], replace: true });
    expect(contents(replaced.profile)).toEqual(['Lives in Mazatlán']);
    expect(replaced.removed).toBe(2);
  });

  test('promotes an existing memory to the profile instead of duplicating it', () => {
    const { item } = addMemory({ content: 'Is allergic to penicillin', kind: 'fact' });
    const res = updateProfile({ facts: ['is allergic to penicillin'] });
    expect(res.alreadyKnown).toBe(1);
    expect(getMemory(item.id)!.kind).toBe('profile');
  });

  test('validates everything before writing', () => {
    expectMemoryError(() => updateProfile({ facts: ['Lives in Culiacán', 'PIN: 4821'] }), 'secret');
    expect(listMemories().total).toBe(0);
    const { item } = addMemory({ content: 'A note', kind: 'note' });
    expectMemoryError(() => updateProfile({ facts: [], remove: [item.id] }), 'invalid');
  });
});

describe('prompt section', () => {
  const mk = (i: number, kind: MemoryItem['kind'], content: string, at: number): MemoryItem => ({
    id: `m${i}`, kind, content, tags: [], source: null, pinned: false, createdAt: at, updatedAt: at, lastUsedAt: null,
  });

  test('stays under the budget and drops the oldest first', () => {
    const profile = Array.from({ length: 60 }, (_, i) => mk(i, 'profile', `Profile fact number ${i} ${'x'.repeat(80)}`, 1_000 + i));
    const preferences = Array.from({ length: 15 }, (_, i) => mk(100 + i, 'preference', `Preference ${i} ${'y'.repeat(150)}`, 5_000 + i));
    const out = renderOwnerKnowledge({ profile, pinned: [], preferences });
    expect(out.length).toBeLessThanOrEqual(OWNER_KNOWLEDGE_BUDGET);
    expect(out).toMatch(/\((\d+) older items left out to save space — `recall` finds them/);
    const omitted = Number(/\((\d+) older items/.exec(out)![1]);
    // Every preference is newer than every profile fact, so all of them survive…
    for (let i = 0; i < 15; i++) expect(out).toContain(`Preference ${i} `);
    // …the newest profile fact survives, the oldest is the first to go.
    expect(out).toContain('Profile fact number 59 ');
    expect(out).not.toContain('Profile fact number 0 ');
    const keptProfile = profile.filter(p => out.includes(`Profile fact number ${p.id.slice(1)} `)).length;
    expect(keptProfile + 15 + omitted).toBe(75);
  });

  test('a small memory renders whole, grouped', () => {
    const out = renderOwnerKnowledge({
      profile: [mk(1, 'profile', 'Lives in Culiacán', 1)],
      pinned: [mk(2, 'note', 'Never book flights before 9am', 2)],
      preferences: [mk(3, 'preference', 'Likes café de olla', 3)],
    });
    expect(out).toContain('## What you know about the owner');
    expect(out).toContain('Profile:\n- Lives in Culiacán');
    expect(out).toContain('Pinned:\n- Never book flights before 9am');
    expect(out).toContain('Preferences (most recently used):\n- Likes café de olla');
    expect(out).not.toContain('left out');
  });

  test('loads profile, pinned and the 15 most recently used preferences', () => {
    updateProfile({ facts: ['Lives in Culiacán'] });
    addMemory({ content: 'Pinned thing', kind: 'fact', pinned: true });
    for (let i = 0; i < 20; i++) addMemory({ content: `Preference number ${i}`, kind: 'preference' });
    addMemory({ content: 'Plain fact', kind: 'fact' });
    const mem = promptMemories(15);
    expect(contents(mem.profile)).toEqual(['Lives in Culiacán']);
    expect(contents(mem.pinned)).toEqual(['Pinned thing']);
    expect(mem.preferences).toHaveLength(15);
  });

  test('people lines carry name, relation and aliases but never handles', () => {
    const p = createPerson({ name: 'Ana López', relation: 'wife', aliases: 'esposita, Anita', handles: { whatsapp: ['6677805604'], email: ['ana@example.com'] } });
    const out = renderPeople([p])!;
    expect(out).toContain('- Ana López (wife) — aka esposita, Anita');
    expect(out).not.toContain('5216677805604');
    expect(out).not.toContain('ana@example.com');
    expect(renderPeople([])).toBeNull();
  });
});

describe('people', () => {
  test('finds people by alias, accent- and case-insensitively', () => {
    const ana = createPerson({ name: 'Ana López', aliases: ['Esposita', 'Anita'], relation: 'esposa', handles: { whatsapp: ['667 780 5604'] } });
    createPerson({ name: 'José Pérez', relation: 'hermano', handles: { telegram: ['@PepePerez'], email: ['Jose@Example.com'] } });
    expect(findPeople('esposita')[0]!.id).toBe(ana.id);
    expect(findPeople('ESPOSITA')[0]!.id).toBe(ana.id);
    expect(findPeople('jose')[0]!.name).toBe('José Pérez');
    expect(findPeople('ana lopez')[0]!.id).toBe(ana.id);
    expect(findPeople('esposa')[0]!.id).toBe(ana.id);
    expect(findPeople('hermano')[0]!.name).toBe('José Pérez');
    expect(findPeople('+52 1 667 780 5604')[0]!.id).toBe(ana.id);
    expect(findPeople('@pepeperez')[0]!.name).toBe('José Pérez');
    expect(findPeople('jose@example.com')[0]!.name).toBe('José Pérez');
    expect(findPeople('nadie')).toEqual([]);
  });

  test('handles are normalised per channel', () => {
    expect(normalizeHandles({
      whatsapp: '6677805604, 5216677805604@s.whatsapp.net',
      phone: ['(667) 780-5604'],
      email: ['MAILTO:Ana@Example.COM'],
      telegram: ['https://t.me/AnaLopez', '123456789'],
    })).toEqual({
      whatsapp: ['5216677805604@s.whatsapp.net'],
      phone: ['+526677805604'],
      email: ['ana@example.com'],
      telegram: ['@analopez', '123456789'],
    });
    expectMemoryError(() => normalizeHandles({ whatsapp: ['not a number'] }), 'invalid');
    expectMemoryError(() => normalizeHandles({ fax: ['123'] }), 'invalid');
    expectMemoryError(() => normalizeHandles(['6677805604']), 'invalid');
  });

  test('channels get the lookups from the area index', () => {
    // The public surface agent/channels builds on — keep these names stable.
    const ana = createPerson({ name: 'Ana Ruiz', aliases: ['Anita'], handles: { telegram: ['@AnaRuiz'], email: ['ana.ruiz@example.com'] } });
    expect(memoryIndex.findPersonByHandle).toBe(findPersonByHandle);
    expect(memoryIndex.findPeople).toBe(findPeople);
    expect(memoryIndex.HANDLE_CHANNELS).toEqual(['whatsapp', 'telegram', 'email', 'phone']);
    expect(memoryIndex.findPersonByHandle('telegram', '@anaruiz')?.id).toBe(ana.id);
    expect(memoryIndex.findPersonByHandle('email', 'Ana.Ruiz@Example.com')?.id).toBe(ana.id);
    expect(memoryIndex.findPersonByHandle('email', 'not an address')).toBeNull();
    expect(memoryIndex.findPeople('anita', 5).map(p => p.id)).toEqual([ana.id]);
  });

  test('looks a sender up by handle', () => {
    const ana = createPerson({ name: 'Ana', handles: { whatsapp: ['6677805604'] } });
    expect(findPersonByHandle('whatsapp', '5216677805604@s.whatsapp.net')!.id).toBe(ana.id);
    expect(findPersonByHandle('whatsapp', '5216677805604:7@s.whatsapp.net')!.id).toBe(ana.id);
    expect(findPersonByHandle('phone', '+52 667 780 5604')!.id).toBe(ana.id);
    expect(findPersonByHandle('whatsapp', '5216670000000@s.whatsapp.net')).toBeNull();
  });

  test('upsert merges by name or alias and adds handles instead of replacing them', () => {
    const first = upsertPerson({ name: 'Ana López', aliases: ['esposita'], handles: { whatsapp: ['6677805604'] } });
    expect(first.created).toBe(true);
    const byAlias = upsertPerson({ name: 'Esposita', handles: { email: ['ana@example.com'] }, relation: 'wife' });
    expect(byAlias.created).toBe(false);
    expect(byAlias.person.id).toBe(first.person.id);
    expect(byAlias.person.name).toBe('Ana López');
    expect(byAlias.person.relation).toBe('wife');
    expect(byAlias.person.handles).toEqual({ whatsapp: ['5216677805604@s.whatsapp.net'], email: ['ana@example.com'] });
    const replaced = upsertPerson({ id: first.person.id, name: 'Ana López', handles: { email: ['new@example.com'] } }, { replace: true });
    expect(replaced.person.handles).toEqual({ email: ['new@example.com'] });
  });

  test('upsert refuses to guess between two people with the same name', () => {
    createPerson({ name: 'Juan' });
    createPerson({ name: 'Juan', relation: 'coworker' });
    expectMemoryError(() => upsertPerson({ name: 'juan', notes: 'x' }), 'conflict');
  });

  test('notes cannot hold secrets', () => {
    expectMemoryError(() => createPerson({ name: 'Bank', notes: 'password: hunter22' }), 'secret');
  });
});

describe('phone numbers', () => {
  const cases: [string, string | null][] = [
    ['6677805604', '5216677805604@s.whatsapp.net'],
    ['667 780 5604', '5216677805604@s.whatsapp.net'],
    ['(667) 780-5604', '5216677805604@s.whatsapp.net'],
    ['+52 667 780 5604', '5216677805604@s.whatsapp.net'],
    ['+52 1 667 780 5604', '5216677805604@s.whatsapp.net'],
    ['526677805604', '5216677805604@s.whatsapp.net'],
    ['5216677805604', '5216677805604@s.whatsapp.net'],
    ['0052 667 780 5604', '5216677805604@s.whatsapp.net'],
    ['044 667 780 5604', '5216677805604@s.whatsapp.net'],
    ['01 667 780 5604', '5216677805604@s.whatsapp.net'],
    ['+1 415 555 0134', '14155550134@s.whatsapp.net'],
    ['+44 20 7946 0958', '442079460958@s.whatsapp.net'],
    ['123', null],
    ['', null],
    ['ana@example.com', null],
    ['call me', null],
  ];

  test('Mexican numbers become WhatsApp JIDs with the mobile 1', () => {
    for (const [input, jid] of cases) expect([input, phoneToWhatsAppJid(input)]).toEqual([input, jid]);
  });

  test('E.164 drops the legacy mobile 1', () => {
    expect(normalizePhone('6677805604')).toBe('+526677805604');
    expect(normalizePhone('+52 1 667 780 5604')).toBe('+526677805604');
    expect(normalizePhone('+1 (415) 555-0134')).toBe('+14155550134');
    expect(normalizePhone('12')).toBeNull();
  });

  test('JIDs are canonicalised; lids and groups pass through', () => {
    expect(normalizeWhatsAppHandle('526677805604@s.whatsapp.net')).toBe('5216677805604@s.whatsapp.net');
    expect(normalizeWhatsAppHandle('5216677805604:12@s.whatsapp.net')).toBe('5216677805604@s.whatsapp.net');
    expect(normalizeWhatsAppHandle('5216677805604@c.us')).toBe('5216677805604@s.whatsapp.net');
    expect(normalizeWhatsAppHandle('123456789012345:3@lid')).toBe('123456789012345@lid');
    expect(normalizeWhatsAppHandle('120363000000000000@g.us')).toBe('120363000000000000@g.us');
  });

  test('the Persona form normalises exactly like the server', () => {
    for (const [input] of cases) expect([input, uiMemory.phoneToWhatsAppJid(input)]).toEqual([input, phoneToWhatsAppJid(input)]);
    for (const jid of ['526677805604@s.whatsapp.net', '5216677805604:12@s.whatsapp.net', '123456789012345:3@lid', '6677805604', 'nope']) {
      expect([jid, uiMemory.normalizeWhatsAppInput(jid)]).toEqual([jid, normalizeWhatsAppHandle(jid)]);
    }
  });
});
