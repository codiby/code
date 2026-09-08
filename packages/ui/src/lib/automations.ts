// Automatizaciones — presentation helpers for the automations REST API.
//
// The definitions themselves live on the bridge (packages/core/automation/*)
// and are read through `ClaudeClient`; this module holds only the pure
// functions that turn those rows into something readable: humanising a cron
// expression, previewing the next few fire times, and labelling run statuses.
//
// Everything here is deliberately dependency-free and side-effect-free so it
// can be unit-tested without a server or a DOM.
import type {
  AutomationEffort,
  AutomationPermissionMode,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationTriggerType,
} from './claude-client';

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const TRIGGER_TYPE_META: Record<AutomationTriggerType, { label: string; hint: string }> = {
  cron: { label: 'Horario', hint: 'Corre sola en el horario que definas.' },
  webhook: { label: 'Webhook', hint: 'Solo corre cuando algo llama a su URL.' },
};

/**
 * The URL an external watcher POSTs to in order to fire a webhook automation.
 * `origin` comes from the live bridge (`client.localServerUrl`), so the port is
 * whatever this machine's sidecar actually bound.
 */
export function webhookUrl(origin: string, automationId: string): string {
  return `${origin.replace(/\/$/, '')}/automations/${automationId}/webhook`;
}

/** Ready-to-paste invocation for the watcher. */
export function webhookCurl(origin: string, automationId: string): string {
  return `curl -X POST ${webhookUrl(origin, automationId)}`;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/** The presets offered by the create form, in the order they are shown. */
export const CRON_PRESETS: { id: string; label: string; cron: string }[] = [
  { id: 'hourly', label: 'Cada hora', cron: '0 * * * *' },
  { id: 'daily', label: 'Diario', cron: '0 9 * * *' },
  { id: 'weekly', label: 'Semanal', cron: '0 9 * * 1' },
];

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Best-effort Spanish rendering of the common 5-field cron shapes. Anything
 * outside the shapes below falls back to the raw expression — the point is to
 * make the frequent cases readable, not to reimplement a cron parser.
 */
export function humanizeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hour, dom, month, dow] = parts;

  const everyMinutes = /^\*\/(\d+)$/.exec(min);
  if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Cada ${everyMinutes[1]} minutos`;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && everyHours && dom === '*' && month === '*' && dow === '*') {
    return `Cada ${everyHours[1]} horas, en el minuto ${min}`;
  }
  if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Cada minuto';
  }
  if (!/^\d+$/.test(min)) return expression;

  const minute = Number(min);
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return minute === 0 ? 'Cada hora, en punto' : `Cada hora, al minuto ${minute}`;
  }
  if (!/^\d+$/.test(hour) || month !== '*') return expression;

  const at = hhmm(Number(hour), minute);
  if (dom === '*' && dow === '*') return `Cada día a las ${at}`;
  if (dom === '*' && /^[0-6]$/.test(dow)) return `Cada ${DAY_NAMES[Number(dow)]} a las ${at}`;
  if (/^\d+$/.test(dom) && dow === '*') return `El día ${dom} de cada mes a las ${at}`;
  return expression;
}

/**
 * Next `count` fire times for a 5-field expression, as epoch millis.
 *
 * Implemented as a minute-by-minute scan from the next whole minute, capped at
 * ~400 days of lookahead. That is fast enough for the 3-item preview the form
 * shows and avoids pulling a cron library into the renderer bundle. Returns an
 * empty array for expressions it cannot parse.
 *
 * NOTE: the scan runs in the *browser's* timezone. The server computes the real
 * `nextRunAt` in the automation's configured timezone, so callers should treat
 * this purely as a form preview and prefer `automation.nextRunAt` once saved.
 */
export function nextCronRuns(expression: string, count = 3, from: number = Date.now()): number[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const fields = [
    matcher(parts[0], 0, 59),
    matcher(parts[1], 0, 23),
    matcher(parts[2], 1, 31),
    matcher(parts[3], 1, 12),
    matcher(parts[4], 0, 6),
  ];
  if (fields.some(f => !f)) return [];
  const [minOk, hourOk, domOk, monthOk, dowOk] = fields as ((n: number) => boolean)[];

  const out: number[] = [];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Day-of-month and day-of-week are OR'd when both are restricted — the
  // standard crontab rule.
  const domRestricted = parts[2] !== '*';
  const dowRestricted = parts[4] !== '*';

  for (let i = 0; i < 400 * 24 * 60 && out.length < count; i++) {
    const dayMatches = domRestricted && dowRestricted
      ? domOk(cursor.getDate()) || dowOk(cursor.getDay())
      : domOk(cursor.getDate()) && dowOk(cursor.getDay());
    if (dayMatches && monthOk(cursor.getMonth() + 1) && hourOk(cursor.getHours()) && minOk(cursor.getMinutes())) {
      out.push(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
}

/** Compile one cron field into a predicate, or null when it is malformed. */
function matcher(field: string, lo: number, hi: number): ((n: number) => boolean) | null {
  const allowed = new Set<number>();
  for (const term of field.split(',')) {
    const [range, stepRaw] = term.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;

    let start: number;
    let end: number;
    if (range === '*') {
      start = lo;
      end = hi;
    } else if (/^\d+-\d+$/.test(range)) {
      [start, end] = range.split('-').map(Number);
    } else if (/^\d+$/.test(range)) {
      start = Number(range);
      end = stepRaw === undefined ? start : hi;
    } else {
      return null;
    }
    if (start < lo || end > hi || start > end) return null;
    for (let n = start; n <= end; n += step) allowed.add(n);
  }
  return allowed.size ? (n: number) => allowed.has(n) : null;
}

// ---------------------------------------------------------------------------
// Run statuses
// ---------------------------------------------------------------------------

export interface RunStatusMeta {
  label: string;
  /** Tailwind text colour for dots, pills and labels. */
  tone: string;
  /** Background used by the sparkline tick for this status. */
  tick: string;
  /** Shown when a run has no output of its own to explain itself. */
  hint?: string;
}

export const RUN_STATUS_META: Record<AutomationRunStatus, RunStatusMeta> = {
  scheduled: { label: 'En cola', tone: 'text-blue-400', tick: 'bg-blue-400/60' },
  running: { label: 'Corriendo', tone: 'text-indigo-400', tick: 'bg-indigo-400' },
  succeeded: { label: 'Correcta', tone: 'text-green-400', tick: 'bg-green-400/60' },
  failed: { label: 'Falló', tone: 'text-red-400', tick: 'bg-red-400' },
  timed_out: {
    label: 'Se pasó',
    tone: 'text-amber-400',
    tick: 'bg-amber-400',
    hint: 'Cortada al llegar al tiempo máximo configurado.',
  },
  cancelled: { label: 'Cancelada', tone: 'text-zinc-400', tick: 'bg-zinc-600', hint: 'Cancelada a mano.' },
  skipped: {
    label: 'Saltada',
    tone: 'text-zinc-400',
    tick: 'bg-surface-lighter',
    // Without this the run looks like it silently vanished — it is the
    // `concurrencyPolicy: 'skip'` behaviour, not a failure.
    hint: 'La ejecución anterior seguía corriendo cuando tocaba esta, así que no se lanzó.',
  },
};

/** Statuses that mean "this automation is unhealthy right now". */
export const FAILING_STATUSES: AutomationRunStatus[] = ['failed', 'timed_out'];

/** What set a given run off, as shown on each history row. */
export const RUN_TRIGGER_LABEL: Record<AutomationRunTrigger, string> = {
  scheduled: 'programada',
  manual: 'manual',
  webhook: 'webhook',
};

// ---------------------------------------------------------------------------
// Labels for the enum-ish config fields
// ---------------------------------------------------------------------------

export const PERMISSION_MODE_META: Record<AutomationPermissionMode, { label: string; hint: string }> = {
  default: { label: 'Preguntar', hint: 'Se detiene ante cualquier acción que requiera permiso.' },
  acceptEdits: { label: 'Aplicar ediciones', hint: 'Edita archivos sin preguntar; el resto se detiene.' },
  bypassPermissions: { label: 'Sin límites', hint: 'Hace cualquier cosa sin preguntar, incluidos comandos.' },
  plan: { label: 'Solo plan', hint: 'Solo redacta un plan; no toca nada.' },
};

export const EFFORT_LABEL: Record<AutomationEffort, string> = {
  low: 'bajo',
  medium: 'medio',
  high: 'alto',
  xhigh: 'muy alto',
  max: 'máximo',
};

export const RUNTIME_PRESETS: { label: string; ms: number | null }[] = [
  { label: '2 minutos', ms: 2 * 60_000 },
  { label: '10 minutos', ms: 10 * 60_000 },
  { label: '30 minutos', ms: 30 * 60_000 },
  { label: '1 hora', ms: 60 * 60_000 },
  { label: 'Sin límite', ms: null },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "hace 3m" / "hace 2h" / "hace 4d" — empty string for a missing timestamp. */
export function relativePast(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '';
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.round(hours / 24)}d`;
}

/** "en 6m" / "en 3h 12m" / "en 4d" — for `nextRunAt`. */
export function relativeFuture(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '—';
  const mins = Math.round((ts - now) / 60_000);
  if (mins <= 0) return 'ahora mismo';
  if (mins < 60) return `en ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `en ${hours}h ${rest}m` : `en ${hours}h`;
  }
  return `en ${Math.round(hours / 24)}d`;
}

/** Short wall-clock stamp, e.g. "hoy 09:00" / "mar 09:00" / "12 mar 09:00". */
export function shortStamp(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const time = hhmm(d.getHours(), d.getMinutes());
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((d.getTime() - startOfToday.getTime()) / 86_400_000);
  if (days === 0) return `hoy ${time}`;
  if (days === 1) return `mañana ${time}`;
  if (days === -1) return `ayer ${time}`;
  if (days > 1 && days < 7) return `${DAY_NAMES[d.getDay()].slice(0, 3)} ${time}`;
  return `${d.getDate()} ${d.toLocaleString('es', { month: 'short' })} ${time}`;
}

/** "1m 42s" / "34s" — from `durationMs`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

/** "$0.084" — sub-cent runs still show three decimals rather than "$0.00". */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** "12.3k" — compact token counts. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Collapse the user's home prefix so paths fit the row. */
export function shortPath(path: string, home?: string | null): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  const match = /^\/(?:Users|home)\/[^/]+(\/.*)$/.exec(path);
  return match ? `~${match[1]}` : path;
}
