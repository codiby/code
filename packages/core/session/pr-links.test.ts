import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { addPRLink, getPRLinks, loadPRLinks, removePRLink, setPRLinks, type PRLink } from './storage';

// Same path storage.ts writes to; CODIBY_DATA_DIR points at a sandbox for the
// whole run (scripts/test-preload.ts).
const PR_LINKS_FILE = join(CODIBY_DIR, 'ui-pr-links.json');

const link = (prNumber: number, repo?: string): PRLink => ({
  prNumber,
  title: `PR ${prNumber}`,
  url: `https://github.com/${repo ?? 'acme/api'}/pull/${prNumber}`,
  headRefName: `feat/${prNumber}`,
  state: 'OPEN',
  repo,
});

afterEach(() => rmSync(PR_LINKS_FILE, { force: true }));

describe('PR links', () => {
  test('reads the pre-multi-repo format as a one-element list', () => {
    writeFileSync(PR_LINKS_FILE, JSON.stringify({
      ses_a: { prNumber: 7, title: 'Legacy', url: 'u', headRefName: 'b', state: 'OPEN' },
    }));

    expect(getPRLinks('ses_a')).toEqual([
      { prNumber: 7, title: 'Legacy', url: 'u', headRefName: 'b', state: 'OPEN' },
    ]);
  });

  test('holds one link per repository for a session that spans two', () => {
    addPRLink('ses_a', link(1, 'acme/api'));
    addPRLink('ses_a', link(1, 'acme/web'));

    expect(getPRLinks('ses_a').map(l => l.repo)).toEqual(['acme/api', 'acme/web']);
  });

  test('re-linking the same PR refreshes it in place instead of duplicating', () => {
    addPRLink('ses_a', link(42, 'acme/api'));
    addPRLink('ses_a', link(9, 'acme/web'));
    addPRLink('ses_a', { ...link(42, 'acme/api'), state: 'MERGED', title: 'Renamed' });

    // Refreshing the first PR must not shuffle it past the second, or the
    // badges in the header reorder every time a state refresh lands.
    expect(getPRLinks('ses_a').map(l => l.prNumber)).toEqual([42, 9]);
    expect(getPRLinks('ses_a')[0]).toMatchObject({ state: 'MERGED', title: 'Renamed' });
  });

  test('a legacy link with no repo is upgraded in place, not duplicated', () => {
    writeFileSync(PR_LINKS_FILE, JSON.stringify({
      ses_a: { prNumber: 42, title: 'Legacy', url: 'u', headRefName: 'b', state: 'OPEN' },
    }));

    addPRLink('ses_a', link(42, 'acme/api'));

    expect(getPRLinks('ses_a')).toHaveLength(1);
    expect(getPRLinks('ses_a')[0]!.repo).toBe('acme/api');
  });

  test('unlinking one PR leaves the session\'s other repo linked', () => {
    addPRLink('ses_a', link(1, 'acme/api'));
    addPRLink('ses_a', link(2, 'acme/web'));

    removePRLink('ses_a', { prNumber: 1, repo: 'acme/api' });

    expect(getPRLinks('ses_a').map(l => l.prNumber)).toEqual([2]);
  });

  test('same PR number in two repos unlinks only the one named', () => {
    addPRLink('ses_a', link(5, 'acme/api'));
    addPRLink('ses_a', link(5, 'acme/web'));

    removePRLink('ses_a', { prNumber: 5, repo: 'acme/web' });

    expect(getPRLinks('ses_a').map(l => l.repo)).toEqual(['acme/api']);
  });

  test('unlinking without a PR clears the session and drops its key', () => {
    addPRLink('ses_a', link(1, 'acme/api'));
    addPRLink('ses_b', link(2, 'acme/web'));

    removePRLink('ses_a');

    expect(loadPRLinks()).not.toHaveProperty('ses_a');
    expect(getPRLinks('ses_b')).toHaveLength(1);
    removePRLink('ses_b');
  });

  test('an empty replacement removes the session rather than persisting []', () => {
    addPRLink('ses_a', link(1, 'acme/api'));

    setPRLinks('ses_a', []);

    expect(loadPRLinks()).not.toHaveProperty('ses_a');
  });

  test('a corrupt file reads as empty instead of throwing', () => {
    writeFileSync(PR_LINKS_FILE, 'not json');

    expect(loadPRLinks()).toEqual({});
  });
});
