/**
 * Shell command classification.
 *
 * Read-only commands run freely; writes confined to the workspace count as
 * workspace writes; anything else that changes state asks; a short list of
 * catastrophic forms (wiping `/` or `~`, formatting disks, piping a download
 * into a shell) is denied outright. The classifier is deliberately
 * pessimistic: an unknown command, a write outside the workspace, or a parse
 * failure is never "read-only".
 */

import { basename } from 'path';
import { bridgeAccess } from './bridge-access';
import { parseShell, ShellParseError, type Segment } from './shell-parse';
import { isInWorkspace, pathSensitivity, resolveToolPath, trimSep, type PathContext } from './paths';

/**
 * Ordered by severity; the worst level found anywhere in a command wins.
 * `bridge` (a call to this Codiby bridge) sits above `other` so a broad
 * "allow shell commands" rule never covers it.
 */
export const SHELL_LEVELS = ['read_only', 'workspace_write', 'other', 'bridge', 'send', 'credentials', 'destructive', 'agent_vault', 'catastrophic'] as const;
export type ShellLevel = typeof SHELL_LEVELS[number];

export interface ShellVerdict {
  level: ShellLevel;
  reasons: string[];
}

const rank = (l: ShellLevel) => SHELL_LEVELS.indexOf(l);

class Verdict {
  level: ShellLevel = 'read_only';
  reasons: string[] = [];
  raise(level: ShellLevel, reason: string) {
    if (rank(level) > rank(this.level)) this.level = level;
    if (level !== 'read_only' && !this.reasons.includes(reason) && this.reasons.length < 6) this.reasons.push(reason);
  }
  merge(v: ShellVerdict) {
    for (const r of v.reasons) this.raise(v.level, r);
    if (rank(v.level) > rank(this.level)) this.level = v.level;
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Commands that only read, with no argument checks needed. */
const READ_ONLY = new Set([
  'ls', 'll', 'la', 'pwd', 'date', 'whoami', 'id', 'groups', 'hostname', 'uname', 'uptime', 'df', 'du', 'free',
  'ps', 'pgrep', 'which', 'whereis', 'type', 'echo', 'printf', 'true', 'false', 'test', '[', '[[', 'stat', 'file',
  'tree', 'wc', 'head', 'tail', 'cat', 'tac', 'nl', 'less', 'more', 'uniq', 'cut', 'tr', 'column', 'comm', 'diff',
  'cmp', 'md5', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'shasum', 'cksum', 'base64', 'basename', 'dirname',
  'realpath', 'readlink', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'locate', 'mdfind', 'jq', 'xxd',
  'hexdump', 'od', 'strings', 'lsof', 'netstat', 'ss', 'dig', 'nslookup', 'host', 'whois', 'ping', 'traceroute',
  'cal', 'bc', 'expr', 'seq', 'sleep', 'cd', 'pushd', 'popd', 'history', 'locale', 'tty', 'nproc', 'sw_vers',
  'system_profiler', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'vm_stat', 'iostat', 'vmstat', 'last', 'w', 'who', 'man',
  'tldr', 'ffprobe', 'identify', 'pdfinfo', 'exa', 'eza', 'bat', 'fold', 'fmt', 'rev', 'paste', 'join', 'look',
  'numfmt', 'tput', 'getconf', 'arch', 'sum', 'zcat', 'gzcat', 'bzcat', 'xzcat', 'zgrep', 'tsort', 'units', 'wait',
]);

/** Prefixes that run the command after them. */
const WRAPPERS = new Set(['nice', 'nohup', 'time', 'command', 'builtin', 'exec', 'stdbuf', 'ionice', 'caffeinate', 'unbuffer', 'chronic']);
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno', 'php', 'lua', 'osascript', 'pwsh']);
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'aria2c']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac', ';;']);
/** Tools where `-v` / `version` prints a version rather than doing something. */
const VERSIONED_TOOLS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'go', 'cargo', 'rustc', 'java', 'npm', 'pnpm', 'yarn',
  'gcc', 'clang', 'make', 'cmake', 'git', 'docker', 'kubectl', 'gh', 'tailscale', 'claude', 'codex', 'opencode', 'uv', 'pip', 'pip3', 'php', 'perl']);
const DISK_DEVICE = /^\/dev\/(sd[a-z]|nvme\d|disk\d|rdisk\d|hd[a-z]|mmcblk\d|vd[a-z]|xvd[a-z]|md\d|dm-\d|mapper\/)/;
const SYSTEM_DIRS = new Set(['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'opt', 'proc', 'root', 'sbin', 'srv', 'sys', 'usr', 'var',
  'Users', 'System', 'Library', 'Applications', 'Volumes', 'private', 'nix', 'snap']);
/** Processes whose death takes the machine, a service, or the agent itself down. */
const SYSTEM_PROCESS = /(^|[\s/])(init|systemd[\w-]*|launchd|kernel_task|sshd|loginwindow|WindowServer|Xorg|Xwayland|gnome-shell|kwin\w*|plasmashell|dbus-daemon|NetworkManager|dockerd|containerd|tailscaled|cron|crond|journald|process-compose|codiby[\w.-]*|Codiby Code)($|[\s/])|^bun$/i;
const SECRET_VAR_NAME = /(TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|(^|_)AUTH($|_))/i;

/** Messaging/email CLIs: sending through them reaches other people. `true` = any use sends. */
const SEND_CLIS = new Map<string, RegExp | true>([
  ['wacli', /^(send|text|reply|message|msg|image|file|media|forward)$/i],
  ['telegram-send', true],
  ['sendmail', true],
  ['mail', true],
  ['mailx', true],
  ['mutt', true],
  ['msmtp', true],
  ['signal-cli', /^send$/],
]);

/** Read-only sub-commands of multi-command tools. */
const READ_SUBCOMMANDS = new Map<string, Set<string>>([
  ['docker', new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'history', 'diff', 'events'])],
  ['podman', new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'history', 'diff', 'events'])],
  ['kubectl', new Set(['get', 'describe', 'logs', 'version', 'top', 'explain', 'api-resources', 'api-versions', 'cluster-info'])],
  ['brew', new Set(['list', 'ls', 'info', 'search', 'outdated', 'deps', 'uses', 'config', 'doctor', 'leaves', 'desc', 'home'])],
  ['npm', new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'explain', 'search', 'ping', 'root', 'prefix'])],
  ['pnpm', new Set(['ls', 'list', 'why', 'outdated'])],
  ['yarn', new Set(['list', 'info', 'why', 'outdated'])],
  ['pip', new Set(['list', 'show', 'freeze', 'check'])],
  ['pip3', new Set(['list', 'show', 'freeze', 'check'])],
  ['tailscale', new Set(['status', 'ip', 'netcheck', 'ping', 'whois', 'version', 'dns'])],
  ['launchctl', new Set(['list', 'print', 'print-disabled', 'blame', 'version', 'help', 'dumpstate'])],
  ['systemctl', new Set(['status', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'help'])],
  ['process-compose', new Set(['list', 'info', 'version'])],
]);
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'blame', 'describe', 'shortlog',
  'grep', 'cat-file', 'rev-list', 'name-rev', 'merge-base', 'whatchanged', 'count-objects', 'version', 'help', 'annotate',
  'show-ref', 'for-each-ref', 'check-ignore', 'cherry', 'range-diff', 'var',
]);
/** Commands that write their path arguments. Copy-like ones write only their last argument. */
const FILE_WRITERS = new Set(['touch', 'truncate', 'mkdir', 'rmdir', 'unlink', 'tee', 'chmod', 'chown', 'chgrp', 'rm', 'shred', 'ssh-keygen']);
const COPY_LIKE = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'scp']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cmdName = (w: string) => basename(w);

/** Expand `$HOME`/`${HOME}` to `~` so path checks see one form. */
function normaliseWord(w: string): string {
  return w.replace(/^"?(?:\$\{HOME\}|\$HOME)"?(?=\/|$)/, '~');
}

/** Short flags (`-rf`) and long flags (`--force`) present in `args`. */
function flagSet(args: string[]): { short: Set<string>; long: Set<string> } {
  const short = new Set<string>();
  const long = new Set<string>();
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('--')) long.add(a.split('=')[0]!);
    else if (/^-[A-Za-z]+$/.test(a)) for (const ch of a.slice(1)) short.add(ch);
  }
  return { short, long };
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === '--') { afterDashDash = true; continue; }
    if (!afterDashDash && a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

/** Path-looking parts of a word, including `--file=x`, `of=x` and `@file` values. */
function pathCandidates(word: string): string[] {
  const out = [word];
  const eq = word.indexOf('=');
  if (eq > 0) out.push(word.slice(eq + 1));
  if (word.startsWith('@')) out.push(word.slice(1));
  if (/^file:\/\//i.test(word)) out.push(word.replace(/^file:\/\//i, ''));
  return out.filter(w => /^[~./]|^\$\{?HOME|\/|^\.env|(^|\/)vault\.(json|key)$/.test(w) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w)).map(normaliseWord);
}

function referencesSecretVar(text: string): boolean {
  for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (SECRET_VAR_NAME.test(m[1]!)) return true;
  }
  return false;
}

function isCatastrophicTarget(word: string, ctx: PathContext): boolean {
  const w = normaliseWord(word).replace(/\/\*?$/, '') || '/';
  if (w === '~' || w === '/') return true;
  const abs = trimSep(resolveToolPath(w, ctx.workspaceDir, ctx.home));
  if (abs === '/' || abs === trimSep(ctx.home)) return true;
  const parts = abs.split('/').filter(Boolean);
  if (parts.length === 1 && SYSTEM_DIRS.has(parts[0]!)) return true;
  // /home/<user> and /Users/<user>
  return parts.length === 2 && (parts[0] === 'home' || parts[0] === 'Users');
}

function insideWorkspace(word: string, ctx: PathContext): boolean {
  if (/[*?]/.test(word) && !/^[^*?]*\//.test(word)) {
    // A bare glob (`*.txt`) expands in the cwd, which is the workspace.
    return !word.startsWith('/') && !word.startsWith('~');
  }
  return isInWorkspace(resolveToolPath(normaliseWord(word), ctx.workspaceDir, ctx.home), ctx);
}

/** A write to `targets`: confined to the workspace, or not. */
function raiseWrite(targets: string[], what: string, ctx: PathContext, v: Verdict) {
  if (targets.length && targets.every(t => insideWorkspace(t, ctx))) v.raise('workspace_write', `${what} inside the workspace`);
  else v.raise('other', `${what} outside the workspace`);
}

// ---------------------------------------------------------------------------
// Per-command analysis
// ---------------------------------------------------------------------------

interface Analysis {
  /** Effective command after wrappers (`sudo`, `env X=1`, `nice`…). */
  cmd: string;
  args: string[];
}

/** Peel wrappers off; reports privilege escalation as it goes. */
function unwrap(words: string[], v: Verdict): Analysis | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    const name = cmdName(w);
    if (KEYWORDS.has(w)) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    if (PRIVILEGE.has(name)) {
      v.raise('destructive', `Runs with elevated privileges (${name})`);
      i++;
      // sudo flags (`-u root`, `-E`) before the command.
      while (i < words.length && words[i]!.startsWith('-')) i += /^-[ugCchpr]$/.test(words[i]!) ? 2 : 1;
      continue;
    }
    if (name === 'env') {
      const rest = words.slice(i + 1).filter(a => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
      if (!rest.length) return { cmd: 'env', args: words.slice(i + 1) };
      i++;
      while (i < words.length && (words[i]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))) i++;
      continue;
    }
    if (name === 'timeout' || name === 'gtimeout') {
      i++;
      while (i < words.length && words[i]!.startsWith('-')) i++;
      i++; // duration
      continue;
    }
    if (WRAPPERS.has(name)) {
      i++;
      while (i < words.length && words[i]!.startsWith('-')) i += name === 'nice' && words[i] === '-n' ? 2 : 1;
      continue;
    }
    return { cmd: name, args: words.slice(i + 1) };
  }
  return null;
}

function analyseRm(args: string[], ctx: PathContext, v: Verdict) {
  const { short, long } = flagSet(args);
  const recursive = short.has('r') || short.has('R') || long.has('--recursive');
  const targets = positional(args);
  if (long.has('--no-preserve-root')) v.raise('catastrophic', 'rm --no-preserve-root');
  if (recursive && targets.some(t => isCatastrophicTarget(t, ctx))) {
    v.raise('catastrophic', 'Recursive delete of the root, home or a system folder');
  } else if (recursive) {
    v.raise('destructive', 'Recursive delete (rm -r)');
  } else {
    raiseWrite(targets, 'Deletes files', ctx, v);
  }
}

function analyseGit(args: string[], v: Verdict) {
  let i = 0;
  // Global options before the sub-command.
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!;
    if (a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path')) {
      v.raise('other', 'git with inline configuration');
      return;
    }
    i += a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return;
  const { short, long } = flagSet(rest);
  if (rest.some(a => a.startsWith('--output'))) { v.raise('other', 'git writes output to a file'); return; }
  switch (sub) {
    case 'push':
      if (short.has('f') || short.has('d') || long.has('--force') || long.has('--force-with-lease') || long.has('--delete') || long.has('--mirror') || long.has('--prune')
        || positional(rest).some(r => r.startsWith(':') || r.startsWith('+'))) {
        v.raise('destructive', 'Force-push or remote branch deletion');
      } else {
        v.raise('other', 'git push');
      }
      return;
    case 'reset':
      if (long.has('--hard') || long.has('--merge') || long.has('--keep')) v.raise('destructive', 'git reset --hard discards work');
      else v.raise('other', 'git reset');
      return;
    case 'clean':
      if (short.has('f') || long.has('--force')) v.raise('destructive', 'git clean -f deletes untracked files');
      else v.raise('other', 'git clean');
      return;
    case 'branch': {
      if (short.has('D') || (short.has('d') && (short.has('f') || long.has('--force')))) { v.raise('destructive', 'Force-deletes a branch'); return; }
      const changes = ['d', 'm', 'M', 'c', 'C', 'u'].some(f => short.has(f))
        || ['--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream', '--edit-description'].some(f => long.has(f));
      if (changes) { v.raise('other', 'Changes branches'); return; }
      const listing = short.has('l') || ['--list', '--contains', '--merged', '--no-merged', '--points-at'].some(f => long.has(f));
      if (positional(rest).length && !listing) v.raise('other', 'Creates a branch');
      return;
    }
    case 'checkout':
    case 'restore':
      if (rest.includes('--') || rest.includes('.') || short.has('f') || long.has('--force')) v.raise('destructive', 'Discards local changes');
      else v.raise('other', `git ${sub}`);
      return;
    case 'stash':
      if (['drop', 'clear'].includes(rest[0] ?? '')) v.raise('destructive', 'Drops stashed work');
      else if (!['list', 'show'].includes(rest[0] ?? '')) v.raise('other', 'git stash');
      return;
    case 'reflog':
      if (['expire', 'delete'].includes(rest[0] ?? '')) v.raise('destructive', 'Rewrites the reflog');
      return;
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
      v.raise('destructive', `git ${sub} rewrites history`);
      return;
    case 'gc':
      if (rest.some(a => a.startsWith('--prune'))) v.raise('destructive', 'git gc --prune');
      else v.raise('other', 'git gc');
      return;
    case 'tag':
      if (rest.length && !rest.every(a => a === '-l' || a === '--list' || a === '-n' || a.startsWith('--sort') || a.startsWith('--contains') || a.startsWith('--points-at'))) {
        v.raise(short.has('d') || long.has('--delete') ? 'destructive' : 'other', 'Changes tags');
      }
      return;
    case 'remote':
      if (rest.length && !['-v', '--verbose', 'show', 'get-url'].includes(rest[0]!)) v.raise('other', 'Changes remotes');
      return;
    case 'config':
      if (rest.some(a => /credential|token|password/i.test(a))) { v.raise('credentials', 'Reads git credentials'); return; }
      if (!rest.some(a => ['--get', '--get-all', '--list', '-l', '--get-regexp', '--show-origin'].includes(a))) v.raise('other', 'git config');
      return;
    case 'credential':
    case 'credential-cache':
    case 'credential-store':
      v.raise('credentials', 'Reads git credentials');
      return;
    case 'worktree':
      if (rest[0] !== 'list') v.raise('other', 'git worktree');
      return;
    case 'submodule':
      if (rest[0] !== 'status') v.raise('other', 'git submodule');
      return;
    default:
      if (!GIT_READ.has(sub)) v.raise('other', `git ${sub}`);
  }
}

/** curl is read-only only as a plain GET to stdout. */
function analyseCurl(args: string[], v: Verdict) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const name = a.split('=')[0]!;
      if (name === '--request') {
        const method = (a.includes('=') ? a.split('=')[1] : args[i + 1] ?? '').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') { v.raise('other', `HTTP ${method || 'request'}`); return; }
      }
      if (/^--(data|form|json|upload-file|post)/.test(name)) { v.raise('other', 'Sends data (POST/upload)'); return; }
      if (/^--(output|remote-name|cookie-jar|dump-header|config|trace|create-dirs|output-dir)/.test(name)) { v.raise('other', 'Writes files'); return; }
      continue;
    }
    if (!/^-[A-Za-z]/.test(a)) continue;
    const letters = a.slice(1);
    // Short flags combine (`-sSLo`); one taking a value ends the group.
    for (let j = 0; j < letters.length; j++) {
      const f = letters[j]!;
      if (f === 'X') {
        const method = (letters.slice(j + 1) || args[i + 1] || '').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') { v.raise('other', `HTTP ${method || 'request'}`); return; }
        break;
      }
      if (f === 'd' || f === 'F' || f === 'T') { v.raise('other', 'Sends data (POST/upload)'); return; }
      if (f === 'o' || f === 'O' || f === 'c' || f === 'D' || f === 'K') { v.raise('other', 'Writes files'); return; }
      if ('HAeEuxrbwmYyzCU'.includes(f)) break;
    }
  }
  const urls = args.filter(a => /^[a-z][a-z0-9+.-]*:\/\//i.test(a));
  if (urls.some(u => !/^https?:\/\//i.test(u))) v.raise('other', 'Non-HTTP URL');
}

function analyseWget(args: string[], v: Verdict) {
  const toStdout = args.some((a, i) => a === '-O-' || a === '-qO-' || (/^-q?O$/.test(a) && args[i + 1] === '-') || a === '--output-document=-');
  if (!toStdout) { v.raise('other', 'Downloads files'); return; }
  if (args.some(a => a.startsWith('--post') || a.startsWith('--method') || a.startsWith('--body'))) v.raise('other', 'Sends data');
}

function analyseSed(args: string[], ctx: PathContext, v: Verdict) {
  if (args.some(a => a === '-i' || a.startsWith('--in-place') || (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--')))) {
    const files = positional(args).slice(1);
    raiseWrite(files, 'Edits files in place (sed -i)', ctx, v);
    return;
  }
  const script = args.filter(a => !a.startsWith('-')).join(' ');
  if (/(^|[;{}\s/])[wWe](\s+\S|$)/.test(script)) v.raise('other', 'sed script writes or executes');
}

function analyseAwk(args: string[], v: Verdict) {
  const script = args.join(' ');
  if (/system\s*\(|>|\||getline|-i\s*inplace/.test(script)) v.raise('other', 'awk script writes or executes');
}

function analyseFind(args: string[], v: Verdict, ctx: PathContext, depth: number) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-delete') {
      const roots = args.slice(0, i).filter(x => !x.startsWith('-'));
      v.raise(roots.some(r => isCatastrophicTarget(r, ctx)) ? 'catastrophic' : 'destructive', 'find -delete');
      return;
    }
    if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
      const end = args.findIndex((x, j) => j > i && (x === ';' || x === '+' || x === '\\;'));
      const inner = args.slice(i + 1, end < 0 ? undefined : end).filter(x => x !== '{}');
      if (inner.length) v.merge(classifyWords(inner, ctx, depth + 1));
      if (end < 0) return;
      i = end;
      continue;
    }
    if (/^-f(print|print0|printf|ls)$/.test(a)) { v.raise('other', 'find writes to a file'); return; }
  }
}

function analyseService(cmd: string, args: string[], v: Verdict) {
  const sub = positional(args)[0];
  if (!sub || READ_SUBCOMMANDS.get(cmd)!.has(sub)) return;
  v.raise('destructive', `${cmd} ${sub} changes system services`);
}

function analyseKill(cmd: string, args: string[], v: Verdict) {
  const targets = positional(args);
  if (cmd === 'kill') {
    if ((args.includes('-1') && targets.length === 0) || targets.some(t => t === '1' || t === '-1')) v.raise('destructive', 'Signals init / every process');
    else v.raise('other', 'Kills a process');
    return;
  }
  const { short } = flagSet(args);
  if (short.has('u') || targets.some(t => SYSTEM_PROCESS.test(t))) v.raise('destructive', `${cmd} of a system process`);
  else v.raise('other', 'Kills processes');
}

function analyseGh(args: string[], v: Verdict) {
  const [group, sub] = positional(args);
  if (group === 'auth' && sub === 'token') { v.raise('credentials', 'Prints the GitHub token'); return; }
  if ((group === 'auth' && sub === 'status') || group === 'status') return;
  if (group === 'api') {
    const writes = args.some((a, i) => ((a === '-X' || a === '--method') && !/^(GET|HEAD)$/i.test(args[i + 1] ?? ''))
      || /^-(f|F)$/.test(a) || a.startsWith('--field') || a.startsWith('--raw-field') || a.startsWith('--input'));
    if (writes) v.raise('other', 'gh api write');
    return;
  }
  const reads: Record<string, string[]> = {
    pr: ['list', 'view', 'diff', 'status', 'checks'],
    issue: ['list', 'view', 'status'],
    repo: ['view', 'list'],
    run: ['list', 'view', 'watch'],
    release: ['list', 'view'],
    workflow: ['list', 'view'],
  };
  if (!group || !sub || !Object.hasOwn(reads, group) || !reads[group]!.includes(sub)) v.raise('other', `gh ${[group, sub].filter(Boolean).join(' ')}`);
}

function analysePathArgs(cmd: string, args: string[], ctx: PathContext, v: Verdict) {
  const pos = positional(args);
  const dest = COPY_LIKE.has(cmd) ? pos[pos.length - 1] : undefined;
  const sedInPlace = (cmd === 'sed' || cmd === 'perl') && args.some(x => /^-[a-zA-Z]*i/.test(x));
  for (const w of args) {
    for (const p of pathCandidates(w)) {
      const abs = resolveToolPath(p, ctx.workspaceDir, ctx.home);
      const s = pathSensitivity(abs, ctx, p);
      if (!s) continue;
      if (s === 'agent_vault') { v.raise('agent_vault', "Touches the agent's vault or config"); continue; }
      const writes = FILE_WRITERS.has(cmd) || sedInPlace || (cmd === 'dd' && w.startsWith('of=')) || (dest !== undefined && w === dest);
      if (s === 'ssh') v.raise(writes ? 'destructive' : 'credentials', writes ? 'Writes to ~/.ssh' : 'Reads SSH keys');
      else v.raise('credentials', writes ? 'Writes a credentials file' : 'Reads a credentials file');
    }
  }
}

function analyseCommand(a: Analysis, seg: Segment, ctx: PathContext, v: Verdict, depth: number) {
  const { cmd, args } = a;

  analysePathArgs(cmd, args, ctx, v);

  if (args.length === 1 && (args[0] === '--version' || args[0] === '--help')) return;
  if (args.length === 1 && VERSIONED_TOOLS.has(cmd) && ['-v', '-V', 'version'].includes(args[0]!)) return;
  const send = SEND_CLIS.get(cmd);
  if (send) {
    if (send === true || args.some(x => send.test(x))) { v.raise('send', `Sends a message with ${cmd}`); return; }
  }
  if (/^(mkfs|newfs)/.test(cmd)) { v.raise('catastrophic', 'Formats a disk'); return; }

  switch (cmd) {
    case 'for':
    case 'case':
    case 'select':
      return;
    case 'export':
      if (!args.length || args.includes('-p')) v.raise('credentials', 'Dumps the environment');
      return;
    case 'env':
    case 'printenv':
    case 'set':
    case 'declare':
    case 'typeset':
    case 'compgen':
      if (cmd === 'printenv' && args.length && !args.some(x => SECRET_VAR_NAME.test(x))) return;
      if (cmd === 'set' && args.length) return;
      if ((cmd === 'declare' || cmd === 'typeset') && args.length && !args.some(x => /^-[a-zA-Z]*[xp]/.test(x))) { v.raise('other', `${cmd} with arguments`); return; }
      v.raise('credentials', 'Dumps environment variables (may contain secrets)');
      return;
    case 'rm':
      analyseRm(args, ctx, v);
      return;
    case 'shred':
    case 'srm':
    case 'wipe':
      v.raise('destructive', `${cmd} destroys files`);
      return;
    case 'wipefs':
    case 'fdisk':
    case 'sfdisk':
    case 'parted':
    case 'sgdisk':
    case 'gdisk':
      v.raise('catastrophic', 'Formats or repartitions a disk');
      return;
    case 'diskutil':
      if (/^(erase|zero|secureErase|partitionDisk|reformat|randomDisk)/.test(args[0] ?? '')) v.raise('catastrophic', 'Erases a disk');
      else if (!['list', 'info'].includes(args[0] ?? '')) v.raise('other', 'diskutil');
      return;
    case 'dd': {
      const of = args.find(x => x.startsWith('of='))?.slice(3) ?? '';
      if (DISK_DEVICE.test(of)) v.raise('catastrophic', 'dd onto a disk device');
      else v.raise('other', 'dd writes raw data');
      return;
    }
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const { short, long } = flagSet(args);
      const targets = positional(args).slice(1);
      if (short.has('R') || long.has('--recursive')) {
        v.raise(targets.some(t => isCatastrophicTarget(t, ctx)) ? 'catastrophic' : 'destructive', `Recursive ${cmd}`);
      } else {
        raiseWrite(targets, `Changes permissions (${cmd})`, ctx, v);
      }
      return;
    }
    case 'touch':
    case 'mkdir':
    case 'tee':
    case 'truncate':
    case 'rmdir':
    case 'unlink':
      raiseWrite(positional(args).filter(p => p !== '-'), cmd === 'tee' ? 'Writes a file' : `${cmd}`, ctx, v);
      return;
    case 'cp':
    case 'ln':
    case 'install':
    case 'rsync': {
      const pos = positional(args);
      if (cmd === 'rsync' && (args.some(x => x.startsWith('--delete')) || pos.some(p => /^[^/]*:/.test(p)))) { v.raise(args.some(x => x.startsWith('--delete')) ? 'destructive' : 'other', 'rsync'); return; }
      raiseWrite(pos.length >= 2 ? [pos[pos.length - 1]!] : [], `${cmd}`, ctx, v);
      return;
    }
    case 'mv':
      raiseWrite(positional(args), 'Moves files', ctx, v);
      return;
    case 'kill':
    case 'pkill':
    case 'killall':
      analyseKill(cmd, args, v);
      return;
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
      v.raise('destructive', 'Shuts the machine down');
      return;
    case 'init':
    case 'telinit':
      if (/^[06]$/.test(args[0] ?? '')) v.raise('destructive', 'Changes the runlevel');
      else v.raise('other', cmd);
      return;
    case 'systemctl':
    case 'launchctl':
      analyseService(cmd, args, v);
      return;
    case 'service':
      if (args[1] !== 'status') v.raise('destructive', 'Changes a system service');
      return;
    case 'journalctl':
      if (args.some(x => /^--(vacuum|rotate|flush|sync|relinquish-var|setup-keys)/.test(x))) v.raise('destructive', 'Deletes or rotates logs');
      return;
    case 'crontab':
      if (args.includes('-r')) v.raise('destructive', 'crontab -r removes every cron job');
      else if (!args.includes('-l')) v.raise('other', 'Changes the crontab');
      return;
    case 'security':
      if (/^(find-(generic|internet)-password|find-key|dump-keychain|export|unlock-keychain)$/.test(args[0] ?? '')) {
        v.raise(args.some(x => /codiby/i.test(x)) ? 'agent_vault' : 'credentials', 'Reads the keychain');
      } else if (!['list-keychains', 'show-keychain-info', 'find-certificate'].includes(args[0] ?? '')) {
        v.raise('other', 'security');
      }
      return;
    case 'secret-tool':
    case 'op':
    case 'bw':
    case 'pass':
    case 'gopass':
    case 'keyring':
    case 'lpass':
      v.raise('credentials', `Reads a password manager (${cmd})`);
      return;
    case 'gpg':
    case 'gpg2':
      if (args.some(x => /^--export-secret|^--decrypt|^-d$/.test(x))) v.raise('credentials', 'Exports or decrypts secrets');
      else if (!args.some(x => /^--(list|fingerprint|verify)/.test(x))) v.raise('other', 'gpg');
      return;
    case 'aws':
      if (/^(configure|sts)$/.test(args[0] ?? '') || args.some(x => /get-secret-value|get-session-token|get-parameter/.test(x))) v.raise('credentials', 'Reads AWS credentials');
      else v.raise('other', 'aws CLI');
      return;
    case 'git':
      analyseGit(args, v);
      return;
    case 'gh':
      analyseGh(args, v);
      return;
    case 'curl':
      analyseCurl(args, v);
      return;
    case 'wget':
      analyseWget(args, v);
      return;
    case 'sed':
    case 'gsed':
      analyseSed(args, ctx, v);
      return;
    case 'awk':
    case 'gawk':
    case 'mawk':
      analyseAwk(args, v);
      return;
    case 'find':
      analyseFind(args, v, ctx, depth);
      return;
    case 'sort':
      if (args.some(x => x === '-o' || x.startsWith('--output'))) v.raise('other', 'sort writes a file');
      return;
    case 'yq':
      if (args.some(x => x === '-i' || x === '--inplace')) v.raise('other', 'yq edits in place');
      return;
    case 'xargs': {
      let j = 0;
      while (j < args.length && args[j]!.startsWith('-')) j += /^-[InLPEdsa]$/.test(args[j]!) ? 2 : 1;
      const inner = args.slice(j);
      if (inner.length) v.merge(classifyWords(inner, ctx, depth + 1));
      return;
    }
    case 'top':
      if (!args.some(x => /^-(l|b|n)/.test(x))) v.raise('other', 'Interactive top');
      return;
    case 'sysctl':
      if (args.some(x => x === '-w' || x.includes('='))) v.raise('destructive', 'Changes kernel settings');
      return;
    case 'ip':
      if (args.some(x => /^(add|del|delete|set|flush|change|replace)$/.test(x))) v.raise('destructive', 'Changes networking');
      return;
    case 'ifconfig':
      if (args.length > 1) v.raise('destructive', 'Changes networking');
      return;
    case 'eval':
    case 'source':
    case '.':
      v.raise('other', `${cmd} runs dynamic code`);
      if (args.length) v.merge(classifyCommand(args.join(' '), ctx, depth + 1));
      return;
    case 'docker':
    case 'podman': {
      const pos = positional(args);
      const sub = pos[0] ?? '';
      if (sub === 'compose' && ['ps', 'logs', 'config', 'ls', 'top', 'version'].includes(pos[1] ?? '')) return;
      if (/^(rm|rmi|prune|kill)$/.test(sub) || (['system', 'volume', 'image', 'container', 'network', 'builder'].includes(sub) && args.some(x => /^(prune|rm)$/.test(x)))) {
        v.raise('destructive', `${cmd} ${sub} deletes containers or data`);
        return;
      }
      if (!READ_SUBCOMMANDS.get(cmd)!.has(sub)) v.raise('other', `${cmd} ${sub}`);
      return;
    }
    case 'kubectl': {
      const sub = positional(args)[0] ?? '';
      if (/^(delete|drain|cordon|replace)$/.test(sub)) { v.raise('destructive', `kubectl ${sub}`); return; }
      if (!READ_SUBCOMMANDS.get('kubectl')!.has(sub)) v.raise('other', 'kubectl');
      return;
    }
    case 'psql':
    case 'mysql':
    case 'sqlite3':
    case 'mongo':
    case 'mongosh':
    case 'redis-cli':
      if (args.some(x => /\b(drop\s+(table|database|schema|collection)|truncate\s+table|flushall|flushdb|dropDatabase)\b/i.test(x))) v.raise('destructive', 'Drops database data');
      else v.raise('other', `${cmd} session`);
      return;
    case 'dropdb':
    case 'dropuser':
      v.raise('destructive', `${cmd} deletes a database`);
      return;
    default:
      break;
  }

  if (SHELLS.has(cmd)) {
    // `bash -c '<script>'` — judge the script itself.
    const ci = args.findIndex(x => /^-[a-z]*c[a-z]*$/.test(x));
    if (ci >= 0 && args[ci + 1] !== undefined) {
      v.merge(classifyCommand(args[ci + 1]!, ctx, depth + 1));
      return;
    }
    for (const body of seg.heredocs) v.merge(classifyCommand(body, ctx, depth + 1));
    v.raise('other', positional(args)[0] ? `Runs a script (${positional(args)[0]})` : 'Runs a shell');
    return;
  }
  const subs = READ_SUBCOMMANDS.get(cmd);
  if (subs) {
    const sub = positional(args)[0] ?? '';
    if (!subs.has(sub)) v.raise('other', `${cmd} ${sub}`.trim());
    return;
  }
  if (READ_ONLY.has(cmd)) return;
  v.raise('other', `Runs ${cmd}`);
}

function firstCommand(script: string): string {
  try {
    const segs = parseShell(script);
    return (segs[0] && unwrap(segs[0].words, new Verdict())?.cmd) || '';
  } catch {
    return '';
  }
}

function classifySegment(seg: Segment, next: Segment | undefined, ctx: PathContext, depth: number, v: Verdict) {
  // Redirections: writes, disk devices, and secrets read through `<`.
  for (const r of seg.redirects) {
    const t = normaliseWord(r.target);
    const writes = /^(>|>>|>\||&>|&>>|<>)$/.test(r.op);
    if (r.op === '>&' || r.op === '<&' || r.op === '<<' || r.op === '<<-' || r.op === '<<<' || !t) continue;
    if (writes && DISK_DEVICE.test(t)) { v.raise('catastrophic', 'Writes onto a disk device'); continue; }
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d)$/.test(t)) continue;
    const abs = resolveToolPath(t, ctx.workspaceDir, ctx.home);
    const s = pathSensitivity(abs, ctx, t);
    if (s === 'agent_vault') v.raise('agent_vault', "Touches the agent's vault or config");
    else if (s === 'ssh') v.raise(writes ? 'destructive' : 'credentials', writes ? 'Writes to ~/.ssh' : 'Reads SSH keys');
    else if (s === 'credentials') v.raise('credentials', writes ? 'Writes a credentials file' : 'Reads a credentials file');
    if (writes) raiseWrite([t], 'Writes a file', ctx, v);
  }

  const a = unwrap(seg.words, v);
  // Substitutions are commands too; downloads executed through them are the classic drive-by.
  for (const inner of seg.substitutions) {
    v.merge(classifyCommand(inner, ctx, depth + 1));
    if (a && FETCHERS.has(firstCommand(inner)) && (INTERPRETERS.has(a.cmd) || a.cmd === 'eval' || a.cmd === 'source' || a.cmd === '.')) {
      v.raise('catastrophic', 'Runs code downloaded from the network');
    }
  }
  if (!a) return;
  if (FETCHERS.has(a.cmd) && seg.pipeToNext && next) {
    const n = unwrap(next.words, new Verdict());
    if (n && (INTERPRETERS.has(n.cmd) || n.cmd === 'eval' || n.cmd === 'source')) v.raise('catastrophic', 'Pipes a download into a shell');
  }
  if (INTERPRETERS.has(a.cmd) && !SHELLS.has(a.cmd)) {
    for (const body of seg.heredocs) v.merge(classifyCommand(body, ctx, depth + 1));
  }
  analyseCommand(a, seg, ctx, v, depth);
}

/** Classify an argv-style command (used by `find -exec` and `xargs`). */
function classifyWords(words: string[], ctx: PathContext, depth: number): ShellVerdict {
  const v = new Verdict();
  classifySegment({ words, redirects: [], substitutions: [], heredocs: [], pipeToNext: false }, undefined, ctx, depth, v);
  return { level: v.level, reasons: v.reasons };
}

const MAX_DEPTH = 4;
const MAX_LENGTH = 20_000;

/** The agent's own output under ~/.codiby, which it may read (mirrors paths.ts CODIBY_READABLE). */
const CODIBY_READABLE_TAIL = /^\/(?:agent\/files|screenshots\/main-session|mockups\/main-session|sessions\/main-session)\//;
/** Secret files of the bridge, however the command reaches them. */
const CODIBY_SECRET_NAME = /\bui-mobile-token\b|\.codiby\/(?:database\.sqlite|requirements\.key|tls\/|pairing\/)/;

/**
 * `~/.codiby` spelled out from the home folder (the home path itself is
 * already folded into `~`), anywhere outside the agent's readable corners.
 * Anchored on the home form, so a repo that merely mentions ".codiby/" in
 * a grep pattern isn't caught.
 */
function touchesCodibyData(text: string): boolean {
  if (CODIBY_SECRET_NAME.test(text)) return true;
  for (const m of text.matchAll(/(?:~|\/(?:Users|home)\/[^/\s'"]+|\/root)\/\.codiby(?=$|[/\s'"|;&<>)])(\/[^\s'"|;&<>)]*)?/g)) {
    if (!CODIBY_READABLE_TAIL.test(m[1] ?? '')) return true;
  }
  return false;
}

/** Raw-text backstops that do not depend on the parse being right. */
function rawChecks(command: string, ctx: PathContext, v: Verdict) {
  let text = command.replace(/(?:\$\{HOME\}|\$HOME)/g, '~');
  if (ctx.home.length > 1) text = text.split(ctx.home).join('~');
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(text)) v.raise('catastrophic', 'Fork bomb');
  if (/\.codiby\/agent(?!\/files\/)(?![\w.-])/.test(text) || /\.config\/codiby(?![\w.-])/.test(text)
    || /\bCODIBY_VAULT_KEY\b/.test(text) || /codiby-agent-vault/.test(text) || /(^|[\s/'"=])vault\.(json|key)\b/.test(text)) {
    v.raise('agent_vault', "Touches the agent's vault or config");
  }
  if (touchesCodibyData(text)) v.raise('agent_vault', "Touches the bridge's tokens or database (~/.codiby)");
  if (/\.claude\/\.credentials|\.wacli\/config\.json/.test(text)) v.raise('agent_vault', 'Touches the Claude or WhatsApp login');
  const bridge = bridgeAccess(text, ctx.bridgePort);
  if (bridge) v.raise(bridge.level === 'secret' ? 'agent_vault' : 'bridge', bridge.reason);
  if (/(>>?|\btee\b(\s+-a)?)\s*["']?[^\s"'|;&]*\.ssh\//.test(text)) v.raise('destructive', 'Writes to ~/.ssh');
  if (referencesSecretVar(text)) v.raise('credentials', 'Reads a secret environment variable');
  if (/\/proc\/[^/\s]+\/environ/.test(text)) v.raise('credentials', 'Reads a process environment');
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b/.test(text)) v.raise('catastrophic', 'Pipes a download into a shell');
}

export function classifyCommand(command: string, ctx: PathContext, depth = 0): ShellVerdict {
  const v = new Verdict();
  const text = command.slice(0, MAX_LENGTH);
  if (!text.trim()) return { level: 'other', reasons: ['Empty command'] };
  if (depth > MAX_DEPTH) return { level: 'other', reasons: ['Deeply nested command'] };
  if (command.length > MAX_LENGTH) v.raise('other', 'Very long command');
  rawChecks(text, ctx, v);
  let segments: Segment[];
  try {
    segments = parseShell(text);
  } catch (err) {
    v.raise('other', err instanceof ShellParseError ? `Could not parse (${err.message})` : 'Could not parse');
    return { level: v.level, reasons: v.reasons };
  }
  segments.forEach((seg, i) => classifySegment(seg, segments[i + 1], ctx, depth, v));
  return { level: v.level, reasons: v.reasons };
}
