/**
 * wacli invocation. Every call is an argv array run with Bun.spawn — never a
 * shell — because message text is written by the model and the model reads
 * untrusted content. Positional values go after `--` so text starting with
 * a dash can't be parsed as a wacli option.
 *
 * The runner is injectable: tests (and anything that must not touch the
 * real WhatsApp backend) pass a fake.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed by the runner's timeout — wacli may have finished its work before it died. */
  timedOut?: boolean;
}

export type CliRunner = (argv: string[], opts?: { timeoutMs?: number }) => Promise<CliResult>;

const MAX_OUTPUT = 1024 * 1024;

export const bunCliRunner: CliRunner = async (argv, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (err) {
    return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, opts.timeoutMs ?? 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), ...(timedOut ? { timedOut } : {}) };
  } finally {
    clearTimeout(timer);
  }
};

export interface WacliTarget {
  binary: string;
  account: string;
}

export type WacliMediaType = 'image' | 'video' | 'audio' | 'document';

function base(t: WacliTarget): string[] {
  return [t.binary, ...(t.account ? ['-a', t.account] : [])];
}

export const wacliArgv = {
  text: (t: WacliTarget, jid: string, text: string) => [...base(t), 'text', '--', jid, text],
  media: (t: WacliTarget, jid: string, path: string, opts: { caption?: string; type?: WacliMediaType } = {}) => [
    ...base(t), 'media',
    ...(opts.caption ? [`--caption=${opts.caption}`] : []),
    ...(opts.type ? [`--type=${opts.type}`] : []),
    '--', jid, path,
  ],
  read: (t: WacliTarget, chat: string, id: string, participant?: string) => [
    ...base(t), 'read', ...(participant ? [`--participant=${participant}`] : []), '--', chat, id,
  ],
  status: (t: WacliTarget) => [...base(t), 'status'],
  /** Webhooks live in wacli's config file, shared by every account. */
  webhookList: (t: WacliTarget) => [t.binary, 'webhook', 'ls', '--json'],
  webhookAdd: (t: WacliTarget, url: string, header: string) => [
    t.binary, 'webhook', 'add', 'message.received', url,
    '--timeout', '15000',
    ...(t.account ? ['--for-account', t.account] : []),
    // Variadic option: keep it last so it doesn't swallow other arguments.
    '-H', header,
  ],
  webhookRemove: (t: WacliTarget, url: string) => [t.binary, 'webhook', 'rm', 'message.received', '--url', url],
  webhookRemoveIndex: (t: WacliTarget, index: number) => [t.binary, 'webhook', 'rm', 'message.received', String(index)],
};

export function mediaTypeFor(mime: string | undefined, voice = false): WacliMediaType {
  if (voice) return 'audio';
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

/** `wacli status` → connection state. */
export function parseWacliStatus(stdout: string): { state: string | null; user: string | null } {
  const state = /^\s*state:\s*(\S+)/im.exec(stdout)?.[1] ?? null;
  const user = /^\s*(?:user|me|jid):\s*(.+)$/im.exec(stdout)?.[1]?.trim() ?? null;
  return { state, user };
}

export interface WacliWebhook {
  url: string;
  headers?: Record<string, string>;
  when?: { account?: string[]; from?: string[]; mentioned?: boolean };
}

/** `wacli webhook ls --json` → the message.received hooks. Its output also carries the backend token: never log it. */
export function parseWebhookList(stdout: string): WacliWebhook[] {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { throw new Error('wacli webhook ls did not return JSON'); }
  const events = (data as { events?: Record<string, unknown> })?.events;
  const hooks = events && typeof events === 'object' ? (events as Record<string, unknown>)['message.received'] : null;
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((h): h is WacliWebhook => !!h && typeof h === 'object' && typeof (h as WacliWebhook).url === 'string');
}

/** Errors wacli reports before it hands anything to WhatsApp. */
const NOT_SENT = /not (connected|logged in|paired|authenticated)|no such (file|account|chat)|not found|invalid|unknown (command|flag|option)|usage:|no (account|session)|not registered|not on whatsapp|permission denied|executable file/i;
/** wacli gave up waiting for WhatsApp's ack: the message may have gone out anyway. */
const MAYBE_SENT = /timed? ?out|timeout|deadline exceeded|context canceled|connection (reset|closed|lost)|websocket .*(closed|disconnected)|broken pipe/i;

/**
 * Did a `wacli text` / `wacli media` run deliver? 'sent' when it exited 0 or
 * printed a message id; 'failed' when it definitely didn't send (safe to
 * retry); 'uncertain' when it was killed or timed out mid-send.
 */
export function sendOutcome(res: CliResult): 'sent' | 'failed' | 'uncertain' {
  if (res.code === 0 && !res.timedOut) return 'sent';
  if (/\bid[:=]\s*[A-Za-z0-9]{8,}/i.test(res.stdout)) return 'sent';
  if (res.timedOut) return 'uncertain';
  // 126/127: not executable / not found — the binary never ran.
  if (res.code === 126 || res.code === 127) return 'failed';
  const out = `${res.stderr}\n${res.stdout}`;
  if (NOT_SENT.test(out)) return 'failed';
  return MAYBE_SENT.test(out) ? 'uncertain' : 'failed';
}

/** Short, single-line error from a failed wacli run (stderr first). */
export function cliError(res: CliResult, what: string): Error {
  const detail = (res.stderr || res.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ').replace(/^error:\s*/i, '');
  return new Error(`${what} failed${detail ? `: ${detail.slice(0, 300)}` : ` (exit ${res.code})`}`);
}
