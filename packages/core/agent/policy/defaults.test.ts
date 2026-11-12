import { describe, expect, test } from 'bun:test';
import { MEMORY_TOOL_NAMES } from '../memory/tools';
import { loginSitePattern } from './approvals';
import { classifyToolCall, type ClassifyContext } from './classify';
import { DEFAULT_RULES } from './defaults';
import { ctx, HOME } from './test-context';
import { decide, type Rule, type RuleAction } from './rules';

/** The defaults exactly as seeded, without touching the database. */
const DEFAULTS: Rule[] = DEFAULT_RULES.map(d => ({ ...d, source: 'default', enabled: true, createdAt: 0, updatedAt: 0, guardrail: d.id.startsWith('default:guard-') }));

let seq = 0;
function userRule(partial: Partial<Rule> & Pick<Rule, 'action'>, source: 'user' | 'always_allow' = 'user'): Rule {
  seq++;
  return { id: `${source}:t${seq}`, priority: 100, toolGlob: '*', pattern: null, category: null, note: null, source, enabled: true, createdAt: seq, updatedAt: seq, guardrail: false, ...partial };
}

function verdict(toolName: string, input: Record<string, unknown>, rules: Rule[] = DEFAULTS, c: ClassifyContext = ctx): RuleAction {
  return decide(rules, toolName, classifyToolCall(toolName, input, c)).action;
}

const SDK = 'mcp__codiby-code-sdk__';
const UI = 'mcp__codiby-code__';

type Row = [string, string, Record<string, unknown>, RuleAction];

const TABLE: Row[] = [
  // Memory: consolidation runs unattended, so none of these may ask.
  ['remember', `${UI}remember`, { content: 'likes tea' }, 'allow'],
  ['recall', `${UI}recall`, { query: 'tea' }, 'allow'],
  ['forget', `${UI}forget`, { id: 'm1' }, 'allow'],
  ['update_profile', `${UI}update_profile`, { section: 'about', text: 'x' }, 'allow'],
  ['people_find', `${UI}people_find`, { query: 'Ana' }, 'allow'],
  ['people_upsert', `${UI}people_upsert`, { name: 'Ana' }, 'allow'],
  ['people_list', `${UI}people_list`, {}, 'allow'],

  // Google
  ['gmail_search', `${UI}gmail_search`, { query: 'from:bank' }, 'allow'],
  ['gmail_read', `${UI}gmail_read`, { id: 'abc' }, 'allow'],
  ['gmail_draft', `${UI}gmail_draft`, { to: 'boss@corp.example', subject: 'Q3' }, 'allow'],
  ['gmail_modify', `${UI}gmail_modify`, { id: 'abc', archive: true }, 'allow'],
  ['gmail_send', `${UI}gmail_send`, { to: 'boss@corp.example', subject: 'Q3' }, 'ask'],
  ['gmail_send a saved draft', `${UI}gmail_send`, { draft_id: 'r-1' }, 'ask'],
  ['calendar_list', `${UI}calendar_list`, {}, 'allow'],
  ['calendar_freebusy', `${UI}calendar_freebusy`, { from: '2026-11-14', to: '2026-11-15' }, 'allow'],
  ['calendar_create, no guests', `${UI}calendar_create`, { summary: 'Dentist', start: '2026-11-14T10:00', end: '2026-11-14T11:00' }, 'allow'],
  ['calendar_create with guests', `${UI}calendar_create`, { summary: 'Sync', start: '2026-11-14T10:00', end: '2026-11-14T11:00', attendees: ['ana@corp.example'] }, 'ask'],
  ['calendar_update, own event', `${UI}calendar_update`, { id: 'solo1', start: '2026-11-14T12:00' }, 'allow'],
  ['calendar_update adding guests', `${UI}calendar_update`, { id: 'solo1', attendees: ['ana@corp.example'] }, 'ask'],
  ['calendar_update, event has guests', `${UI}calendar_update`, { id: 'team1', start: '2026-11-14T12:00' }, 'ask'],
  ['calendar_update, event not seen', `${UI}calendar_update`, { id: 'mystery', start: '2026-11-14T12:00' }, 'ask'],
  ['calendar_delete, own event', `${UI}calendar_delete`, { id: 'solo1' }, 'allow'],
  ['calendar_delete, event has guests', `${UI}calendar_delete`, { id: 'team1' }, 'ask'],

  // Browser: reading and navigating run freely…
  ['browser_snapshot', `${SDK}browser_snapshot`, { name: 'docs' }, 'allow'],
  ['browser_take_screenshot', `${SDK}browser_take_screenshot`, { name: 'docs' }, 'allow'],
  ['browser_console_messages', `${SDK}browser_console_messages`, { name: 'docs' }, 'allow'],
  ['browser_network_requests', `${SDK}browser_network_requests`, { name: 'docs' }, 'allow'],
  ['browser_wait_for', `${SDK}browser_wait_for`, { name: 'docs', text: 'Done' }, 'allow'],
  ['browser_open', `${SDK}browser_open`, { name: 'docs', url: 'https://docs.example.com' }, 'allow'],
  ['browser_close', `${SDK}browser_close`, { name: 'docs' }, 'allow'],
  ['browser_scroll', `${SDK}browser_scroll`, { name: 'docs' }, 'allow'],
  ['browser_hover', `${SDK}browser_hover`, { name: 'shop', ref: 'e7' }, 'allow'],
  ['browser_navigate', `${SDK}browser_navigate`, { name: 'docs', action: 'goto', url: 'https://docs.example.com/x' }, 'allow'],
  // …acting runs freely unless it looks like a purchase…
  ['browser_click', `${SDK}browser_click`, { name: 'docs', ref: 'e9' }, 'allow'],
  ['browser_click on "Place your order"', `${SDK}browser_click`, { name: 'shop', ref: 'e7' }, 'ask'],
  ['browser_type', `${SDK}browser_type`, { name: 'docs', ref: 'e2', text: 'codiby' }, 'allow'],
  ['browser_type a card number', `${SDK}browser_type`, { name: 'docs', ref: 'e2', text: '4242 4242 4242 4242' }, 'ask'],
  ['browser_press_key', `${SDK}browser_press_key`, { name: 'docs', key: 'Enter' }, 'allow'],
  ['browser_press_key on the cart', `${SDK}browser_press_key`, { name: 'shop', key: 'Enter' }, 'ask'],
  ['browser_select_option', `${SDK}browser_select_option`, { name: 'docs', ref: 'e2', values: ['Spanish'] }, 'allow'],
  ['browser_handle_dialog', `${SDK}browser_handle_dialog`, { name: 'docs', accept: true }, 'allow'],
  // …scripts and saved logins ask.
  ['browser_evaluate', `${SDK}browser_evaluate`, { name: 'docs', function: '() => document.cookie' }, 'ask'],
  ['browser_fill_secret, first time', `${UI}browser_fill_secret`, { secret: 'site:example.com', field: 'password', ref: 'e3' }, 'ask'],

  // Phone: the device confirms what's sensitive.
  ['phone_act', `${UI}phone_act`, { action: 'tap', node: 3 }, 'allow'],
  ['phone_read_screen', `${UI}phone_read_screen`, {}, 'allow'],
  ['phone_notifications', `${UI}phone_notifications`, {}, 'allow'],
  ['phone_reply_notification', `${UI}phone_reply_notification`, { key: 'n1', text: 'ok' }, 'allow'],

  // This bridge and its secrets.
  ['curl the bridge', 'Bash', { command: 'curl -s http://localhost:3111/sessions' }, 'ask'],
  ['ui_exec to the bridge', `${UI}ui_exec`, { command: 'curl -s 127.0.0.1:3111/health' }, 'ask'],
  ['navigate to the bridge', `${SDK}browser_navigate`, { name: 'x', action: 'goto', url: 'http://localhost:3111/' }, 'ask'],
  ['WebFetch the bridge', 'WebFetch', { url: 'http://localhost:3111/sessions', prompt: 'x' }, 'ask'],
  ['curl /agent/config', 'Bash', { command: 'curl -s http://localhost:3111/agent/config' }, 'deny'],
  ['curl /agent/secrets', 'Bash', { command: 'curl -s localhost:3111/agent/secrets' }, 'deny'],
  ['curl /mobile/pair', 'Bash', { command: 'curl -s localhost:3111/mobile/pair' }, 'deny'],
  ['approve a pairing', 'Bash', { command: `curl -X POST localhost:3111/agent/channels/tg/pairings/42 -d '{"approve":true}'` }, 'deny'],
  ['reveal a channel token', 'Bash', { command: `curl -X POST localhost:3111/agent/channels/wa/secret -d '{"action":"reveal"}'` }, 'deny'],
  ['open /agent/config in the browser', `${SDK}browser_open`, { name: 'x', url: 'http://127.0.0.1:3111/agent/config' }, 'deny'],
  ['read the mobile token', 'Read', { file_path: `${HOME}/.codiby/ui-mobile-token` }, 'deny'],
  ['read the Claude login', 'Read', { file_path: `${HOME}/.claude/.credentials.json` }, 'deny'],
  ['read the WhatsApp CLI config', 'Bash', { command: 'cat ~/.wacli/config.json' }, 'deny'],
  ['read an own screenshot', 'Read', { file_path: `${HOME}/.codiby/screenshots/main-session/a.png` }, 'allow'],

  // Same bare names on someone else's MCP server get no free pass.
  ['other server remember', 'mcp__evil__remember', { content: 'x' }, 'ask'],
  ['other server phone tool', 'mcp__evil__phone_wipe', {}, 'ask'],
  ['other server gmail_search', 'mcp__evil__gmail_search', { query: 'x' }, 'ask'],
  ['other server browser_snapshot', 'mcp__evil__browser_snapshot', {}, 'ask'],
];

describe('default policy', () => {
  for (const [name, tool, input, expected] of TABLE) {
    test(`${name} → ${expected}`, () => {
      expect(verdict(tool, input)).toBe(expected);
    });
  }

  test('the memory rule covers every memory tool', () => {
    const glob = DEFAULT_RULES.find(r => r.id === 'default:memory')!.toolGlob.split(',');
    expect([...glob].sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
    // Explicit, so switching off the broad "agent's own tools" rule can't stall consolidation.
    const withoutInternal = DEFAULTS.map(r => (r.id === 'default:agent-internal' ? { ...r, enabled: false } : r));
    for (const t of MEMORY_TOOL_NAMES) expect(verdict(`${UI}${t}`, {}, withoutInternal)).toBe('allow');
  });

  test('a broad user allow still never reaches the bridge secrets', () => {
    const rules = [...DEFAULTS, userRule({ toolGlob: 'Bash', action: 'allow' })];
    expect(verdict('Bash', { command: 'curl -s localhost:3111/agent/secrets' }, rules)).toBe('deny');
    // The owner's explicit choice wins over the bridge ask, as for any other ask.
    expect(verdict('Bash', { command: 'curl -s localhost:3111/sessions' }, rules)).toBe('allow');
  });

  test('a site rule from the first approval covers that site and its subdomains only', () => {
    const rules = [...DEFAULTS, userRule({ toolGlob: 'browser_fill_secret', pattern: loginSitePattern('example.com'), action: 'allow' }, 'always_allow')];
    const fill = (secret: string) => verdict(`${UI}browser_fill_secret`, { secret, field: 'password', ref: 'e3' }, rules);
    expect(fill('site:example.com')).toBe('allow');
    expect(fill('site:Login.Example.com')).toBe('allow');
    expect(fill('site:other.org')).toBe('ask');
    expect(fill('site:example.com.evil.net')).toBe('ask');
    expect(fill('site:notexample.com')).toBe('ask');
  });
});
