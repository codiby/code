/**
 * Agent view → Rules: how the agent's tool calls are decided. Approval
 * settings, the owner's own rules (create / edit / disable / delete), a box
 * to test what would happen to a tool call, and the defaults (toggle only,
 * with a reset).
 */

import { useEffect, useState } from 'react';
import { FlaskConical, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  agentPolicy,
  ruleTitle,
  shortToolName,
  type AgentRule,
  type PolicySettings,
  type RuleAction,
  type RuleCategory,
  type RuleDraft,
  type RuleTestResult,
} from '../../lib/agent/policy';
import { Button, Card, EmptyNote, ErrorNote, Field, INPUT_CLASS, LABEL_CLASS, Pill, Section, Spinner, Toggle, usePolled, type AgentSectionProps } from './ui';

type Api = AgentSectionProps['api'];
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const ACTION_TONE: Record<RuleAction, 'green' | 'amber' | 'red'> = { allow: 'green', ask: 'amber', deny: 'red' };
const ACTION_LABEL: Record<RuleAction, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

export function ActionPill({ action }: { action: RuleAction | null }) {
  if (!action) return <Pill tone="indigo">Owner</Pill>;
  return <Pill tone={ACTION_TONE[action]}>{ACTION_LABEL[action]}</Pill>;
}

function categoryLabel(categories: RuleCategory[], value: string | null): string | null {
  if (!value) return null;
  return categories.find(c => c.value === value)?.label ?? value;
}

export function RulesSection({ api, refreshKey }: AgentSectionProps) {
  const rules = usePolled(() => agentPolicy.rules(api), [api, refreshKey]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rules.loading && !rules.data) return <Spinner />;
  if (!rules.data) return <ErrorNote message={`Couldn't load the rules: ${rules.error ?? 'unknown error'}`} onRetry={() => void rules.reload()} />;
  const { categories } = rules.data;
  const userRules = rules.data.rules.filter(r => r.source !== 'default');
  const defaults = rules.data.rules.filter(r => r.source === 'default');

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await rules.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (r: AgentRule) => run(r.id, () => agentPolicy.updateRule(api, r.id, { enabled: !r.enabled }));
  const remove = (r: AgentRule) => {
    if (!window.confirm('Delete this rule?')) return;
    void run(r.id, () => agentPolicy.deleteRule(api, r.id));
  };
  const resetDefaults = () => {
    if (!window.confirm('Turn every default rule back on and restore its original definition? Your own rules stay as they are.')) return;
    void run('reset', () => agentPolicy.resetDefaults(api));
  };

  return (
    <>
      <ApprovalSettings api={api} refreshKey={refreshKey} />

      {error && <div className="mb-3"><ErrorNote message={error} /></div>}

      <Section
        title="Your rules"
        hint="Checked before the defaults. The lowest priority number wins; on a tie, deny beats ask beats allow."
        action={editing !== 'new' && <Button onClick={() => setEditing('new')}><Plus size={12} /> New rule</Button>}
      >
        {editing === 'new' && (
          <div className="mb-2">
            <RuleForm
              categories={categories}
              onCancel={() => setEditing(null)}
              onSave={async draft => {
                await agentPolicy.createRule(api, draft);
                setEditing(null);
                await rules.reload();
              }}
            />
          </div>
        )}
        {userRules.length === 0 && editing !== 'new' ? (
          <EmptyNote>No rules of your own yet. Add one, or pick “Always allow” on an approval in Activity.</EmptyNote>
        ) : (
          <div className="flex flex-col gap-1.5">
            {userRules.map(r => editing === r.id ? (
              <RuleForm
                key={r.id}
                categories={categories}
                initial={r}
                onCancel={() => setEditing(null)}
                onSave={async draft => {
                  await agentPolicy.updateRule(api, r.id, draft);
                  setEditing(null);
                  await rules.reload();
                }}
              />
            ) : (
              <RuleRow
                key={r.id}
                rule={r}
                categories={categories}
                busy={busy === r.id}
                onToggle={() => void toggle(r)}
                onEdit={() => setEditing(r.id)}
                onDelete={() => remove(r)}
              />
            ))}
          </div>
        )}
      </Section>

      <TestBox api={api} categories={categories} />

      <Section
        title="Defaults"
        hint="What the agent may do on its own. You can turn any default off; guardrails block even when one of your rules allows."
        action={<Button onClick={resetDefaults} disabled={busy === 'reset'}><RotateCcw size={12} /> Reset defaults</Button>}
      >
        <div className="flex flex-col gap-1.5">
          {defaults.map(r => (
            <RuleRow key={r.id} rule={r} categories={categories} busy={busy === r.id} onToggle={() => void toggle(r)} />
          ))}
        </div>
      </Section>
    </>
  );
}

const CHIP_CLASS = 'font-mono text-[10.5px] text-zinc-400 bg-base border border-border rounded px-1.5 py-px break-words';
/** Beyond this many tools a rule shows "+N more" (the full list is in its tooltip). */
const TOOL_CHIPS = 6;

function RuleRow({ rule, categories, busy, onToggle, onEdit, onDelete }: {
  rule: AgentRule;
  categories: RuleCategory[];
  busy: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const cat = categoryLabel(categories, rule.category);
  // One chip per tool: a single chip for "a,b,c,…" broke mid-name across lines.
  const tools = rule.toolGlob === '*' ? [] : rule.toolGlob.split(',').map(t => t.trim()).filter(Boolean);
  const shown = tools.length > TOOL_CHIPS ? tools.slice(0, TOOL_CHIPS - 1) : tools;
  return (
    <div className={`flex items-start gap-3 px-3 py-2 rounded-md border border-border bg-surface ${rule.enabled ? '' : 'opacity-55'}`}>
      <div className="w-[46px] shrink-0 pt-0.5"><ActionPill action={rule.action} /></div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-zinc-200 break-words">{ruleTitle(rule, cat)}</div>
        <div className="text-[11px] text-zinc-500 flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1">
          {shown.length > 0 && (
            <span className="inline-flex flex-wrap gap-1 min-w-0">
              {shown.map(t => <code key={t} className={CHIP_CLASS}>{t}</code>)}
              {tools.length > shown.length && <span className={`${CHIP_CLASS} cursor-default`} title={tools.slice(shown.length).join('\n')}>+{tools.length - shown.length} more</span>}
            </span>
          )}
          {cat && <span>{cat}</span>}
          {rule.pattern && <code className={`${CHIP_CLASS} break-all`}>/{rule.pattern}/</code>}
          {rule.toolGlob === '*' && !cat && !rule.pattern && <span>Every tool call</span>}
          <span className="text-zinc-600">priority {rule.priority}</span>
          {rule.guardrail && <Pill tone="red">Guardrail</Pill>}
          {rule.source === 'always_allow' && <Pill tone="indigo">From an approval</Pill>}
        </div>
      </div>
      {onEdit && (
        <button type="button" onClick={onEdit} title="Edit rule" aria-label="Edit rule" className="w-7 h-7 grid place-items-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light">
          <Pencil size={12} />
        </button>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} title="Delete rule" aria-label="Delete rule" className="w-7 h-7 grid place-items-center rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10">
          <Trash2 size={12} />
        </button>
      )}
      <div className="pt-1"><Toggle on={rule.enabled} onClick={onToggle} disabled={busy} label={rule.enabled ? 'Disable rule' : 'Enable rule'} /></div>
    </div>
  );
}

function RuleForm({ categories, initial, onSave, onCancel }: {
  categories: RuleCategory[];
  initial?: AgentRule;
  onSave: (draft: RuleDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [toolGlob, setToolGlob] = useState(initial?.toolGlob === '*' ? '' : initial?.toolGlob ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [pattern, setPattern] = useState(initial?.pattern ?? '');
  const [action, setAction] = useState<RuleAction>(initial?.action ?? 'ask');
  const [priority, setPriority] = useState(String(initial?.priority ?? 100));
  const [note, setNote] = useState(initial?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const p = Number(priority);
    if (!Number.isInteger(p) || p < 0 || p > 999) { setError('Priority must be a whole number from 0 to 999.'); return; }
    if (pattern) {
      try { new RegExp(pattern, 'i'); } catch (err) { setError(`Pattern: ${errorText(err)}`); return; }
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ toolGlob: toolGlob.trim() || '*', category: category || null, pattern: pattern || null, action, priority: p, note: note.trim() || null });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-indigo-400/30">
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Tool" hint='Name or glob, comma-separated: "Bash", "gmail_*", "mcp__server__*". Empty = any tool.'>
            <input className={`${INPUT_CLASS} font-mono`} value={toolGlob} onChange={e => setToolGlob(e.target.value)} placeholder="any tool" />
          </Field>
          <Field label="Category">
            <select className={INPUT_CLASS} value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">Any category</option>
              {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Pattern" hint="Optional regular expression, tested against the command, path, recipient or URL (case-insensitive).">
          <input className={`${INPUT_CLASS} font-mono`} value={pattern} onChange={e => setPattern(e.target.value)} placeholder="^git push origin main$" />
        </Field>
        <div className="grid grid-cols-[auto_110px_1fr] gap-2.5 items-start">
          <div className="mb-3">
            <span className={LABEL_CLASS}>Action</span>
            <div className="flex rounded-md border border-border overflow-hidden" role="radiogroup" aria-label="Action">
              {(['allow', 'ask', 'deny'] as RuleAction[]).map(a => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={action === a}
                  onClick={() => setAction(a)}
                  className={`px-3 h-[30px] text-[12px] transition-colors ${action === a ? 'bg-indigo-400/20 text-indigo-200' : 'text-zinc-400 hover:bg-surface-light'}`}
                >
                  {ACTION_LABEL[a]}
                </button>
              ))}
            </div>
          </div>
          <Field label="Priority">
            <input className={INPUT_CLASS} inputMode="numeric" value={priority} onChange={e => setPriority(e.target.value)} />
          </Field>
          <Field label="Note">
            <input className={INPUT_CLASS} value={note} onChange={e => setNote(e.target.value)} placeholder="Why this rule exists" maxLength={300} />
          </Field>
        </div>
        {error && <div className="mb-2.5"><ErrorNote message={error} /></div>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" tone="primary" disabled={saving}>{initial ? 'Save rule' : 'Add rule'}</Button>
        </div>
      </form>
    </Card>
  );
}

const PRESETS: { label: string; toolName: string; input: Record<string, unknown> }[] = [
  { label: 'ls -la', toolName: 'Bash', input: { command: 'ls -la' } },
  { label: 'git push --force', toolName: 'Bash', input: { command: 'git push --force origin main' } },
  { label: 'rm -rf ~', toolName: 'Bash', input: { command: 'rm -rf ~' } },
  { label: 'Edit /etc/hosts', toolName: 'Edit', input: { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' } },
  { label: 'Email someone', toolName: 'mcp__codiby-code__gmail_send', input: { to: 'someone@example.com', subject: 'Hello', body: '…' } },
  { label: 'Message the owner', toolName: 'mcp__codiby-code__send_message', input: { to: 'owner', text: 'Done' } },
];

function TestBox({ api, categories }: { api: Api; categories: RuleCategory[] }) {
  const [toolName, setToolName] = useState('Bash');
  const [inputText, setInputText] = useState(JSON.stringify({ command: 'git push origin main' }, null, 2));
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    let input: unknown;
    try { input = inputText.trim() ? JSON.parse(inputText) : {}; } catch { setError('Input must be valid JSON.'); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { setError('Input must be a JSON object.'); return; }
    setRunning(true);
    setError(null);
    try {
      setResult(await agentPolicy.testCall(api, toolName.trim(), input as Record<string, unknown>));
    } catch (err) {
      setError(errorText(err));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const category = result ? (result.qualifier ? `${result.category}:${result.qualifier}` : result.category) : null;

  return (
    <Section title="Test a tool call" hint="See how the agent's rules would decide a call, without running it.">
      <Card>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {PRESETS.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => { setToolName(p.toolName); setInputText(JSON.stringify(p.input, null, 2)); setResult(null); }}
              className="text-[11px] px-2 py-0.5 rounded-full border border-border text-zinc-400 hover:text-zinc-200 hover:bg-surface-light"
            >
              {p.label}
            </button>
          ))}
        </div>
        <Field label="Tool name">
          <input className={`${INPUT_CLASS} font-mono`} value={toolName} onChange={e => setToolName(e.target.value)} placeholder="Bash" />
        </Field>
        <Field label="Input (JSON)">
          <textarea className={`${INPUT_CLASS} font-mono min-h-[84px] resize-y`} value={inputText} onChange={e => setInputText(e.target.value)} spellCheck={false} />
        </Field>
        {error && <div className="mb-2.5"><ErrorNote message={error} /></div>}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {result && (
              <div className="text-[12px] text-zinc-300">
                <div className="flex items-center gap-2 flex-wrap">
                  <ActionPill action={result.action} />
                  <span className="text-zinc-400">{categoryLabel(categories, category) ?? category}</span>
                </div>
                <div className="mt-1.5 break-words">{result.summary}</div>
                <div className="mt-1 text-[11px] text-zinc-500 break-words">
                  {result.rule ? <>Rule: {ruleTitle(result.rule, categoryLabel(categories, result.rule.category))}</> : result.reason}
                  {result.reasons.length > 0 && <> · {result.reasons.join(' · ')}</>}
                </div>
              </div>
            )}
          </div>
          <Button tone="primary" onClick={() => void run()} disabled={running || !toolName.trim()}>
            <FlaskConical size={12} /> Test
          </Button>
        </div>
        {result?.target && shortToolName(toolName) === 'Bash' && result.action === 'ask' && (
          <p className="text-[11px] text-zinc-500 mt-2">Tip: “Always allow” on an approval adds a rule for exactly this command.</p>
        )}
      </Card>
    </Section>
  );
}

function ApprovalSettings({ api, refreshKey }: { api: Api; refreshKey: number }) {
  const settings = usePolled(() => agentPolicy.settings(api), [api, refreshKey]);
  const [timeout, setTimeoutText] = useState('');
  const [retention, setRetention] = useState('');
  const [error, setError] = useState<string | null>(null);
  const s = settings.data;

  useEffect(() => {
    if (!s) return;
    setTimeoutText(String(s.approvalTimeoutMinutes));
    setRetention(String(s.activityRetentionDays));
  }, [s?.approvalTimeoutMinutes, s?.activityRetentionDays]);

  if (!s) return settings.error ? <div className="mb-[18px]"><ErrorNote message={`Couldn't load approval settings: ${settings.error}`} /></div> : null;

  const save = async (patch: Partial<PolicySettings>) => {
    setError(null);
    try {
      settings.setData(await agentPolicy.saveSettings(api, patch));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const saveNumber = (key: 'approvalTimeoutMinutes' | 'activityRetentionDays', text: string) => {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) { setError('Enter a positive number.'); return; }
    if (n !== s[key]) void save({ [key]: n });
  };

  return (
    <Section title="Approvals" hint="When a tool call needs you, the request goes to all your channels with a code you can reply with.">
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-zinc-200">Approvals from every session</div>
            <div className="text-[11px] text-zinc-500">Also send coding sessions' permission requests to your channels, not only the agent's. Phone push has its own switch in Agent → Devices.</div>
          </div>
          <Toggle on={s.approvalsForAllSessions} onClick={() => void save({ approvalsForAllSessions: !s.approvalsForAllSessions })} label="Approvals from every session" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="block">
            <span className={LABEL_CLASS}>Agent approvals expire after (minutes)</span>
            <input className={INPUT_CLASS} inputMode="numeric" value={timeout} onChange={e => setTimeoutText(e.target.value)} onBlur={() => saveNumber('approvalTimeoutMinutes', timeout)} />
          </label>
          <label className="block">
            <span className={LABEL_CLASS}>Keep activity for (days)</span>
            <input className={INPUT_CLASS} inputMode="numeric" value={retention} onChange={e => setRetention(e.target.value)} onBlur={() => saveNumber('activityRetentionDays', retention)} />
          </label>
        </div>
        <p className="text-[11px] text-zinc-500 -mt-1">An expired approval counts as a denial and you're told about it. Other sessions keep waiting until you answer.</p>
        {error && <ErrorNote message={error} />}
      </Card>
    </Section>
  );
}
