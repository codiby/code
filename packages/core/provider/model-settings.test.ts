import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeSettingsModel, settledClaudeSettingsModel } from './model-settings';
import { defaultModelLabel } from '../../ui/src/lib/default-models';
import { sessionToJSON } from '../session/sessions';
import type { Session } from '../types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'model-settings-'));
  roots.push(root);
  const home = join(root, 'home'), cwd = join(root, 'project');
  for (const dir of [home, cwd]) mkdirSync(join(dir, '.claude'), { recursive: true });
  const settings = (dir: string, name: string, model: unknown) => writeFileSync(join(dir, '.claude', name), JSON.stringify({ model }));
  return { home, cwd, settings };
}
const catalog = [{ id: 'default', label: 'Default', description: 'Opus 5.5 · Recommended' }, { id: 'opus', label: 'Opus 5.5' }];

test('remote host settings override the generic SDK catalogue default in the selector', async () => {
  const { home, cwd, settings } = fixture();
  settings(home, 'settings.json', 'fable[1m]');
  expect(defaultModelLabel(undefined, catalog, await claudeSettingsModel(cwd, home, {}))).toBe('fable[1m]');
  settings(home, 'settings.json', 'opus');
  expect(defaultModelLabel(undefined, catalog, await claudeSettingsModel(cwd, home, {}))).toBe('Opus 5.5');
  expect(defaultModelLabel('opus', catalog, 'fable[1m]')).toBe('Opus 5.5');
});

test('local, project and environment model overrides retain their precedence', async () => {
  const { home, cwd, settings } = fixture();
  settings(home, 'settings.json', 'opus');
  settings(cwd, 'settings.json', 'sonnet');
  expect(await claudeSettingsModel(cwd, home, {})).toBe('sonnet');
  settings(cwd, 'settings.local.json', 'fable[1m]');
  expect(await claudeSettingsModel(cwd, home, {})).toBe('fable[1m]');
  expect(await claudeSettingsModel(cwd, home, { ANTHROPIC_MODEL: 'haiku' })).toBe('haiku');
});

test('missing, malformed and non-string settings do not break the session list', async () => {
  const { home, cwd, settings } = fixture();
  expect(await claudeSettingsModel(cwd, home, {})).toBeNull();
  settings(home, 'settings.json', 'fable[1m]');
  writeFileSync(join(cwd, '.claude/settings.json'), '{');
  settings(cwd, 'settings.local.json', 42);
  expect(await claudeSettingsModel(cwd, home, {})).toBe('fable[1m]');
});

test('session metadata carries its host default without changing its selected model', async () => {
  const { home, cwd, settings } = fixture();
  settings(home, 'settings.json', 'fable[1m]');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const previousModel = process.env.ANTHROPIC_MODEL;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  delete process.env.ANTHROPIC_MODEL;
  try {
    const session = { cwd, provider: 'claude', model: null } as Session;
    expect(sessionToJSON(session, 3111).provider_default_model).toBeNull();
    await settledClaudeSettingsModel(cwd);
    const metadata = sessionToJSON(session, 3111);
    expect(metadata.model).toBeNull();
    expect(metadata.provider_default_model).toBe('fable[1m]');
    expect(defaultModelLabel(undefined, catalog, metadata.provider_default_model)).toBe('fable[1m]');
    expect(sessionToJSON({ ...session, provider: 'codex' }, 3111).provider_default_model).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = previousModel;
  }
});
