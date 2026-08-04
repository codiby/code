import { beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDir = mkdtempSync(join(tmpdir(), 'codiby-requirements-'));
process.env.CODIBY_DATABASE_FILE = join(testDir, 'database.sqlite');
process.env.CODIBY_REQUIREMENTS_KEY_FILE = join(testDir, 'requirements.key');

let repository: typeof import('./repository');
let runner: typeof import('./runner');
/** Resolved from the module, not rebuilt here: `bun test` shares one process,
 *  so whichever test file imports `../database` first fixes the path. */
let DATABASE_FILE: string;

const SESSION = 'ses_test';

const commandRequirement = (title: string, command: string) => ({
  title,
  check: { type: 'command' as const, command },
});

beforeAll(async () => {
  repository = await import('./repository');
  runner = await import('./runner');
  ({ DATABASE_FILE } = await import('../database'));
});

// The sqlite handle and its file are process-wide: another test file may still
// be running against them after this suite finishes, so cleanup waits for the
// process to exit rather than happening in afterAll.
process.on('exit', () => rmSync(testDir, { recursive: true, force: true }));

describe('requirement lifecycle', () => {
  test('adds, locks, records a run, and reports progress', () => {
    repository.setTarget(SESSION, 'Build the requirements panel', 'agent');
    expect(repository.getTarget(SESSION)).toBe('Build the requirements panel');

    const [first, second] = repository.addRequirements(SESSION, [
      commandRequirement('Typecheck is clean', 'bun run typecheck'),
      commandRequirement('Tests pass', 'bun test'),
    ], 'agent');

    // Drafts don't count towards anything until the user approves them.
    expect(repository.progressFor(SESSION)).toMatchObject({ total: 2, draft: 2, locked: 0, complete: false });

    repository.lockRequirement(SESSION, first!.id);
    repository.lockRequirement(SESSION, second!.id);

    repository.recordRunResult(SESSION, first!.id, { status: 'passing', exitCode: 0, output: 'ok' });
    expect(repository.progressFor(SESSION)).toMatchObject({ locked: 2, passing: 1, complete: false });

    repository.recordRunResult(SESSION, second!.id, { status: 'passing', exitCode: 0 });
    expect(repository.progressFor(SESSION).complete).toBe(true);
  });

  test('the agent cannot edit a locked requirement', () => {
    const [requirement] = repository.addRequirements(SESSION, [
      commandRequirement('Lint is clean', 'bun run lint'),
    ], 'agent');

    // Still a draft — the agent owns it.
    expect(repository.editRequirement(SESSION, requirement!.id, { title: 'Lint is clean-ish' }, 'agent').ok).toBe(true);

    repository.lockRequirement(SESSION, requirement!.id);
    const denied = repository.editRequirement(SESSION, requirement!.id, {
      check: { type: 'command', command: 'true' },
    }, 'agent');
    expect(denied.ok).toBe(false);
    expect(repository.getRequirement(SESSION, requirement!.id)?.command).toBe('bun run lint');

    // The user is not blocked.
    expect(repository.editRequirement(SESSION, requirement!.id, { title: 'Lint clean' }, 'user').ok).toBe(true);
  });

  test('a waived requirement never counts as a pass', () => {
    const session = 'ses_waive';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Ship the docs', 'test -f README.md'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);
    repository.waiveRequirement(session, requirement!.id, 'Docs move to the next milestone');

    const progress = repository.progressFor(session);
    expect(progress).toMatchObject({ waived: 1, locked: 0, passing: 0 });
    // No locked requirements left ⇒ nothing to be complete about.
    expect(progress.complete).toBe(false);
  });
});

describe('proposals', () => {
  test('a proposal changes nothing until the user approves it', () => {
    const session = 'ses_proposals';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Bundle stays under 1MB', 'test $(stat -f%z dist/app.js) -lt 1000000'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);

    const proposed = repository.createProposal(session, requirement!.id, {
      action: 'waive',
      reason: 'The budget was raised to 2MB this sprint',
    });
    expect(proposed.ok).toBe(true);

    // Still locked and still in force.
    expect(repository.getRequirement(session, requirement!.id)?.state).toBe('locked');
    expect(repository.progressFor(session).pendingProposals).toBe(1);

    repository.resolveProposal(session, (proposed as { proposal: { id: string } }).proposal.id, 'approved');
    expect(repository.getRequirement(session, requirement!.id)?.state).toBe('waived');
    expect(repository.progressFor(session).pendingProposals).toBe(0);
  });

  test('a rejected proposal leaves the requirement alone', () => {
    const session = 'ses_reject';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Types are clean', 'bun run typecheck'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);

    const proposed = repository.createProposal(session, requirement!.id, {
      action: 'delete',
      reason: 'It is inconvenient',
    });
    repository.resolveProposal(session, (proposed as { proposal: { id: string } }).proposal.id, 'rejected');
    expect(repository.getRequirement(session, requirement!.id)?.state).toBe('locked');
  });
});

describe('tamper detection', () => {
  test('editing the status straight in sqlite is caught and forced to failing', () => {
    const session = 'ses_forge';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Tests pass', 'bun test'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);
    repository.recordRunResult(session, requirement!.id, { status: 'failing', exitCode: 1, output: 'boom' });

    // Simulate the agent going around the repository.
    const sqlite = new Database(DATABASE_FILE);
    sqlite.run(`UPDATE session_requirements SET status = 'passing' WHERE id = ?`, [requirement!.id]);
    sqlite.close();

    const reread = repository.getRequirement(session, requirement!.id)!;
    expect(reread.status).toBe('failing');
    expect(reread.lastVerdict).toContain('signature did not verify');
    expect(repository.progressFor(session).complete).toBe(false);
  });

  test('rewriting a locked command marks the requirement tampered', () => {
    const session = 'ses_rewrite';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Integration suite passes', 'bun test integration'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);

    const sqlite = new Database(DATABASE_FILE);
    sqlite.run(`UPDATE session_requirements SET command = 'true' WHERE id = ?`, [requirement!.id]);
    sqlite.close();

    const reread = repository.getRequirement(session, requirement!.id)!;
    expect(reread.state).toBe('tampered');
    expect(repository.progressFor(session)).toMatchObject({ tampered: 1, locked: 0 });

    // A tampered requirement can never be reported as passing again.
    repository.recordRunResult(session, requirement!.id, { status: 'passing', exitCode: 0 });
    expect(repository.getRequirement(session, requirement!.id)?.status).toBe('failing');
  });

  test('deleting a row out of the middle breaks the chain', () => {
    const session = 'ses_chain';
    const created = repository.addRequirements(session, [
      commandRequirement('One', 'echo 1'),
      commandRequirement('Two', 'echo 2'),
      commandRequirement('Three', 'echo 3'),
    ], 'agent');

    const sqlite = new Database(DATABASE_FILE);
    sqlite.run(`DELETE FROM session_requirements WHERE id = ?`, [created[1]!.id]);
    sqlite.close();

    const rows = repository.listRequirements(session);
    expect(rows).toHaveLength(2);
    // The survivor after the gap no longer links to anything valid.
    expect(rows.find(r => r.id === created[2]!.id)?.state).toBe('tampered');
  });

  test('an unrelated edit does not launder a tampered requirement', () => {
    const session = 'ses_launder';
    const created = repository.addRequirements(session, [
      commandRequirement('First', 'echo first'),
      commandRequirement('Second', 'echo second'),
    ], 'agent');

    const sqlite = new Database(DATABASE_FILE);
    sqlite.run(`UPDATE session_requirements SET title = 'Rewritten' WHERE id = ?`, [created[0]!.id]);
    sqlite.close();

    expect(repository.getRequirement(session, created[0]!.id)?.state).toBe('tampered');
    // Touch the sibling — the repository re-signs the chain around it.
    repository.editRequirement(session, created[1]!.id, { title: 'Second, revised' }, 'user');
    expect(repository.getRequirement(session, created[0]!.id)?.state).toBe('tampered');
  });
});

describe('command runner', () => {
  test('exit code decides the outcome, and only the runner writes it', async () => {
    const session = 'ses_runner';
    const created = repository.addRequirements(session, [
      commandRequirement('Passes', 'exit 0'),
      commandRequirement('Fails', 'echo "nope" >&2; exit 3'),
    ], 'agent');
    created.forEach(r => repository.lockRequirement(session, r.id));

    const summary = await runner.runRequirements(session);
    expect(summary.ran).toBe(2);
    expect(repository.getRequirement(session, created[0]!.id)?.status).toBe('passing');

    const failed = repository.getRequirement(session, created[1]!.id)!;
    expect(failed.status).toBe('failing');
    expect(failed.lastExitCode).toBe(3);
    expect(failed.lastOutput).toContain('nope');

    expect(runner.formatRunSummary(summary)).toContain('1 passing');
  });

  test('a command that outruns its timeout fails', async () => {
    const session = 'ses_timeout';
    const [requirement] = repository.addRequirements(session, [
      { title: 'Slow check', check: { type: 'command' as const, command: 'sleep 5', timeoutMs: 1_000 } },
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);

    await runner.runRequirements(session);
    const reread = repository.getRequirement(session, requirement!.id)!;
    expect(reread.status).toBe('failing');
    expect(reread.lastVerdict).toContain('Timed out');
  });

  test('waived requirements are skipped, not run', async () => {
    const session = 'ses_skip';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Skipped', 'exit 0'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);
    repository.waiveRequirement(session, requirement!.id, 'Out of scope');

    const summary = await runner.runRequirements(session);
    expect(summary.ran).toBe(0);
    expect(summary.skipped[0]).toContain('waived');
  });
});

describe('degenerate check detection', () => {
  test('flags checks that can never fail, and only those', async () => {
    const { degenerateCheckWarning } = await import('./types');
    const flagged = (cmd: string) => degenerateCheckWarning('command', cmd, null) !== null;

    expect(flagged('true')).toBe(true);
    expect(flagged('exit 0')).toBe(true);
    expect(flagged('bun run lint || true')).toBe(true);
    expect(flagged('echo ok')).toBe(true);
    expect(flagged('')).toBe(true);

    expect(flagged('bun test')).toBe(false);
    expect(flagged('bun run typecheck')).toBe(false);
    // Starts with echo but still fails — chaining means the exit code is real.
    expect(flagged('echo "context" >&2; exit 1')).toBe(false);
    expect(flagged('echo running && bun test')).toBe(false);

    // Visual checks are graded on the prompt instead.
    expect(degenerateCheckWarning('visual', null, 'se ve bien')).not.toBeNull();
    expect(degenerateCheckWarning('visual', null,
      'El estado de cada requerimiento es un punto de color, no un checkbox')).toBeNull();
  });
});

describe('audit trail', () => {
  test('records who did what', () => {
    const session = 'ses_events';
    const [requirement] = repository.addRequirements(session, [
      commandRequirement('Builds', 'bun run build'),
    ], 'agent');
    repository.lockRequirement(session, requirement!.id);
    repository.recordRunResult(session, requirement!.id, { status: 'passing', exitCode: 0 });

    const events = repository.listEvents(session);
    expect(events.map(e => e.event)).toEqual(expect.arrayContaining(['created', 'locked', 'run']));
    expect(events.find(e => e.event === 'created')?.actor).toBe('agent');
    expect(events.find(e => e.event === 'locked')?.actor).toBe('user');
    expect(events.find(e => e.event === 'run')?.actor).toBe('runner');
  });
});
