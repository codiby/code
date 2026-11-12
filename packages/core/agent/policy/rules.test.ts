import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { database } from '../../database';
import { agentRules } from '../../database/schema';
import type { Classification } from './classify';
import { DEFAULT_RULES } from './defaults';
import {
  createRule,
  decide,
  deleteRule,
  ensureDefaultRules,
  globToRegExp,
  invalidateRules,
  listRules,
  patternProblem,
  resetDefaultRules,
  updateRule,
  type Rule,
} from './rules';

let seq = 0;
function rule(partial: Partial<Rule> & Pick<Rule, 'action'>): Rule {
  seq++;
  return {
    id: partial.id ?? `t:${seq}`,
    priority: 100,
    toolGlob: '*',
    pattern: null,
    category: null,
    note: null,
    source: 'user',
    enabled: true,
    createdAt: seq,
    updatedAt: seq,
    guardrail: false,
    ...partial,
  };
}

const shell = (command: string, qualifier = 'other'): Classification => ({ category: 'shell', qualifier, summary: `Shell command: ${command}`, target: command, reasons: [] });

describe('decide (precedence)', () => {
  test('lowest priority number wins', () => {
    const rules = [rule({ action: 'deny', priority: 200, toolGlob: 'Bash' }), rule({ action: 'allow', priority: 50, toolGlob: 'Bash' })];
    expect(decide(rules, 'Bash', shell('ls')).action).toBe('allow');
  });

  test('ties go deny > ask > allow', () => {
    const rules = [rule({ action: 'allow', toolGlob: 'Bash' }), rule({ action: 'ask', toolGlob: 'Bash' }), rule({ action: 'deny', toolGlob: 'Bash' })];
    expect(decide(rules, 'Bash', shell('x')).action).toBe('deny');
    expect(decide(rules.slice(0, 2), 'Bash', shell('x')).action).toBe('ask');
  });

  test('disabled rules are ignored; nothing matching asks', () => {
    const rules = [rule({ action: 'allow', toolGlob: 'Bash', enabled: false })];
    const m = decide(rules, 'Bash', shell('x'));
    expect(m.action).toBe('ask');
    expect(m.rule).toBeNull();
  });

  test('globs match bare and full names; categories match qualifiers', () => {
    const r = rule({ action: 'allow', toolGlob: 'gmail_*' });
    const mail: Classification = { category: 'mail', summary: 'x', reasons: [] };
    expect(decide([r], 'mcp__codiby-code__gmail_modify', mail).action).toBe('allow');
    expect(decide([rule({ action: 'deny', toolGlob: 'mcp__codiby-code__*' })], 'mcp__codiby-code__gmail_modify', mail).action).toBe('deny');
    expect(decide([rule({ action: 'allow', category: 'shell:read_only' })], 'Bash', shell('ls', 'read_only')).action).toBe('allow');
    expect(decide([rule({ action: 'allow', category: 'shell:read_only' })], 'Bash', shell('rm x', 'other')).action).toBe('ask');
    expect(decide([rule({ action: 'deny', category: 'shell' })], 'Bash', shell('ls', 'read_only')).action).toBe('deny');
  });

  test("default rules' bare names mean Codiby's tools; user rules match bare names anywhere", () => {
    const cls: Classification = { category: 'other', qualifier: 'mcp', summary: 'phone_wipe on MCP server "evil"', reasons: [] };
    const builtin = rule({ action: 'allow', toolGlob: 'phone_*', source: 'default' });
    expect(decide([builtin], 'mcp__codiby-code__phone_act', cls).action).toBe('allow');
    expect(decide([builtin], 'phone_act', cls).action).toBe('allow');
    expect(decide([builtin], 'mcp__evil__phone_wipe', cls).rule).toBeNull();
    // A default naming the full tool still matches it.
    expect(decide([rule({ action: 'allow', toolGlob: 'mcp__evil__*', source: 'default' })], 'mcp__evil__phone_wipe', cls).action).toBe('allow');
    expect(decide([rule({ action: 'allow', toolGlob: 'phone_*' })], 'mcp__evil__phone_wipe', cls).action).toBe('allow');
  });

  test('patterns match the target or summary, case-insensitively', () => {
    const r = rule({ action: 'allow', toolGlob: 'Bash', pattern: '^git push origin main$' });
    expect(decide([r], 'Bash', shell('git push origin main')).action).toBe('allow');
    expect(decide([r], 'Bash', shell('GIT PUSH ORIGIN MAIN')).action).toBe('allow');
    expect(decide([r], 'Bash', shell('git push origin main --force')).action).toBe('ask');
  });

  test('guardrails beat any allowing rule, until disabled', () => {
    const guard = rule({ id: 'default:guard-catastrophic', action: 'deny', priority: 1000, category: 'destructive:catastrophic', source: 'default', guardrail: true });
    const broad = rule({ action: 'allow', priority: 10, toolGlob: 'Bash' });
    const cls: Classification = { category: 'destructive', qualifier: 'catastrophic', summary: 'rm -rf ~', target: 'rm -rf ~', reasons: [] };
    expect(decide([guard, broad], 'Bash', cls)).toMatchObject({ action: 'deny', rule: { id: 'default:guard-catastrophic' } });
    expect(decide([{ ...guard, enabled: false }, broad], 'Bash', cls).action).toBe('allow');
  });
});

describe('patterns and globs', () => {
  test('rejects unsafe or invalid patterns', () => {
    expect(patternProblem('(a+)+$')).toMatch(/Nested quantifiers/);
    expect(patternProblem('(\\w*)*')).toMatch(/Nested quantifiers/);
    expect(patternProblem('(a)\\1')).toMatch(/Backreferences/);
    expect(patternProblem('[unclosed')).toMatch(/Invalid regular expression/);
    expect(patternProblem('x'.repeat(301))).toMatch(/too long/);
    expect(patternProblem('^git (status|log)\\b')).toBeNull();
  });

  test('glob conversion escapes regex characters', () => {
    expect(globToRegExp('mcp__a.b__*').test('mcp__a.b__x')).toBe(true);
    expect(globToRegExp('mcp__a.b__*').test('mcp__aXb__x')).toBe(false);
    expect(globToRegExp('phone_?ct').test('phone_act')).toBe(true);
  });
});

describe('rule storage', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) database.delete(agentRules).where(eq(agentRules.id, id)).run();
    invalidateRules();
  });

  test('defaults are visible before seeding and seeding is idempotent', () => {
    database.delete(agentRules).where(eq(agentRules.source, 'default')).run();
    invalidateRules();
    expect(listRules().filter(r => r.source === 'default')).toHaveLength(DEFAULT_RULES.length);
    ensureDefaultRules();
    ensureDefaultRules();
    const rows = database.select().from(agentRules).where(eq(agentRules.source, 'default')).all();
    expect(rows).toHaveLength(DEFAULT_RULES.length);
  });

  test('seeding keeps the enabled flag, refreshes definitions and drops retired defaults', () => {
    ensureDefaultRules();
    database.update(agentRules).set({ enabled: false, note: 'stale note' }).where(eq(agentRules.id, 'default:read')).run();
    database.insert(agentRules).values({ id: 'default:retired', toolGlob: '*', action: 'allow', source: 'default', createdAt: 1, updatedAt: 1 }).run();
    ensureDefaultRules();
    const read = database.select().from(agentRules).where(eq(agentRules.id, 'default:read')).get()!;
    expect(read.enabled).toBe(false);
    expect(read.note).toBe(DEFAULT_RULES.find(d => d.id === 'default:read')!.note);
    expect(database.select().from(agentRules).where(eq(agentRules.id, 'default:retired')).get()).toBeUndefined();
    resetDefaultRules();
    expect(listRules().find(r => r.id === 'default:read')!.enabled).toBe(true);
  });

  test('defaults can be toggled but not edited or deleted', () => {
    ensureDefaultRules();
    expect(updateRule('default:read', { enabled: false }).enabled).toBe(false);
    expect(() => updateRule('default:read', { action: 'deny' })).toThrow(/only be enabled or disabled/);
    expect(() => deleteRule('default:read')).toThrow(/cannot be deleted/);
    updateRule('default:read', { enabled: true });
  });

  test('user rules validate input and round-trip', () => {
    const r = createRule({ toolGlob: 'Bash', pattern: '^ls\\b', action: 'allow', note: 'listing' });
    created.push(r.id);
    expect(r).toMatchObject({ source: 'user', priority: 100, action: 'allow', toolGlob: 'Bash' });
    expect(updateRule(r.id, { priority: 5, enabled: false })).toMatchObject({ priority: 5, enabled: false });
    expect(() => createRule({ action: 'allow' })).toThrow(/allowing everything/);
    expect(() => createRule({ action: 'maybe' })).toThrow(/allow, ask or deny/);
    expect(() => createRule({ action: 'ask', category: 'nonsense' })).toThrow(/Unknown category/);
    expect(() => createRule({ action: 'ask', pattern: '(a+)+' })).toThrow(/Nested/);
    expect(() => createRule({ action: 'ask', toolGlob: 'Bash; DROP TABLE' })).toThrow(/toolGlob/);
    expect(() => createRule({ action: 'ask', toolGlob: 'Bash', priority: 1000 })).toThrow(/priority/);
    deleteRule(r.id);
    created.length = 0;
    expect(listRules().some(x => x.id === r.id)).toBe(false);
  });

  test('a user rule outranks the defaults', () => {
    ensureDefaultRules();
    const r = createRule({ toolGlob: 'Bash', pattern: '^npm test$', action: 'allow' });
    created.push(r.id);
    const m = decide(listRules(), 'Bash', shell('npm test'));
    expect(m.rule?.id).toBe(r.id);
    expect(decide(listRules(), 'Bash', shell('npm publish')).rule?.id).toBe('default:ask-shell');
  });
});
