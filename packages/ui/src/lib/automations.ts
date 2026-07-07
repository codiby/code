// Automatizaciones — client-side definitions store.
//
// This holds the *definitions* of automations (cron jobs, scheduled agents,
// event rules) shown in the Automatizaciones view. Persistence is local
// (localStorage) — the same pattern used by the panels store — so the feature
// is self-contained and survives reloads without a server round-trip.
//
// NOTE: this layer only models and persists definitions + their last-run
// metadata. The scheduler that actually fires these on a cron/interval and
// spawns sessions is a separate backend concern (server/) and is intentionally
// not wired here yet — toggling `enabled` records intent, it does not start a
// timer.
import { useSyncExternalStore } from 'react';

export type AutomationKind = 'cron' | 'agent' | 'rule';

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  enabled: boolean;
  /** Human-readable cadence, e.g. "Cada día · 9:00" (cron/agent kinds). */
  schedule?: string;
  /** Raw cron expression when kind is 'cron'. */
  cron?: string;
  /** Event that fires a 'rule' automation, e.g. "Sesión completa". */
  trigger?: string;
  /** What the automation does when it runs (free text / action label). */
  action?: string;
  /** Working directory the spawned session should use. */
  cwd?: string;
  /** Optional group name this automation is scoped to. */
  groupName?: string;
  /** Provider model id used when spawning (agent kind). */
  model?: string;
  /** Prompt sent to the spawned session. */
  prompt?: string;
  createdAt: number;
  lastRunAt?: number;
  lastRunOk?: boolean;
}

const LS_KEY = 'taskr.automations.v1';

let cache: Automation[] | null = null;
const listeners = new Set<() => void>();

function read(): Automation[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    cache = raw ? (JSON.parse(raw) as Automation[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: Automation[]) {
  cache = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / unavailable — keep the in-memory copy */
  }
  listeners.forEach(l => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Unique-enough id without pulling a dependency; collisions are astronomically
// unlikely for hand-authored automation lists.
function newId(): string {
  return 'auto_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const automations = {
  list(): Automation[] {
    return read();
  },
  add(input: Omit<Automation, 'id' | 'createdAt'>): Automation {
    const now = Date.now();
    const item: Automation = { ...input, id: newId(), createdAt: now };
    write([...read(), item]);
    return item;
  },
  update(id: string, patch: Partial<Automation>) {
    write(read().map(a => (a.id === id ? { ...a, ...patch } : a)));
  },
  toggle(id: string) {
    write(read().map(a => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  },
  remove(id: string) {
    write(read().filter(a => a.id !== id));
  },
};

/** React hook: live list of automations, re-renders on any mutation. */
export function useAutomations(): Automation[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** Pretty labels for each kind, reused by the view. */
export const KIND_META: Record<AutomationKind, { label: string; group: string }> = {
  cron: { label: 'Cron', group: 'Programadas' },
  agent: { label: 'Agente', group: 'Agentes programados' },
  rule: { label: 'Regla', group: 'Reglas' },
};
