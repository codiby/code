import { describe, expect, test } from 'bun:test';
import { DISPOSABLES_GROUP_ID, expiredDisposables, parseDisposableTtl, placeInDisposables, refileDisposables } from './disposables';

const HOUR = 60 * 60_000;

describe('expiredDisposables', () => {
  const base = { status: 'open', updatedAt: 0, disposableTtlMs: HOUR, busy: false };

  test('archives a disposable once its idle time runs out', () => {
    expect(expiredDisposables([{ ...base, id: 'a' }], HOUR)).toEqual(['a']);
    expect(expiredDisposables([{ ...base, id: 'a' }], HOUR - 1)).toEqual([]);
  });

  test('leaves regular, archived and mid-turn sessions alone', () => {
    const list = [
      { ...base, id: 'regular', disposableTtlMs: null },
      { ...base, id: 'archived', status: 'archived' },
      { ...base, id: 'busy', busy: true },
    ];
    expect(expiredDisposables(list, 10 * HOUR)).toEqual([]);
  });
});

describe('placeInDisposables', () => {
  test('creates the folder on first use and files the session there', () => {
    const r = placeInDisposables('s1', {}, {});
    expect(r.groups[DISPOSABLES_GROUP_ID]?.name).toBe('Disposables');
    expect(r.map).toEqual({ s1: DISPOSABLES_GROUP_ID });
  });

  test('reuses the folder the user may have renamed or recoloured', () => {
    const groups = { [DISPOSABLES_GROUP_ID]: { id: DISPOSABLES_GROUP_ID, name: 'Scratch', color: 'pink' } };
    const r = placeInDisposables('s2', groups, { s1: DISPOSABLES_GROUP_ID });
    expect(r.groups[DISPOSABLES_GROUP_ID]?.name).toBe('Scratch');
    expect(r.map).toEqual({ s1: DISPOSABLES_GROUP_ID, s2: DISPOSABLES_GROUP_ID });
  });
});

describe('refileDisposables', () => {
  test('re-creates a dropped folder and files the stray disposables', () => {
    const list = [
      { id: 'd1', disposableTtlMs: HOUR },
      { id: 'd2', disposableTtlMs: HOUR },
      { id: 'regular', disposableTtlMs: null },
    ];
    const r = refileDisposables(list, {}, { d2: 'gone' });
    expect(r?.groups[DISPOSABLES_GROUP_ID]?.name).toBe('Disposables');
    expect(r?.map).toEqual({ d1: DISPOSABLES_GROUP_ID, d2: DISPOSABLES_GROUP_ID });
  });

  test('leaves disposables the user filed elsewhere, and reports nothing to do', () => {
    const groups = { mine: { id: 'mine', name: 'Mine' } };
    expect(refileDisposables([{ id: 'd1', disposableTtlMs: HOUR }], groups, { d1: 'mine' })).toBeNull();
  });
});

test('parseDisposableTtl only accepts the offered lifetimes', () => {
  expect(parseDisposableTtl(HOUR)).toBe(HOUR);
  expect(parseDisposableTtl(1)).toBeNull();
  expect(parseDisposableTtl('3600000')).toBeNull();
});
