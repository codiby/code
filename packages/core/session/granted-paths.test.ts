import { describe, expect, test } from 'bun:test';
import type { Session } from '../types';
import { grantAttachedPaths, isGrantedRead } from './granted-paths';

const session = () => ({ id: 's1' }) as Session;

describe('granted paths', () => {
  test('grants exactly the attached file', () => {
    const s = session();
    grantAttachedPaths(s, 'look at [report.pdf · 2.1 MB](codiby-file:/Users/me/Downloads/report.pdf)');
    expect(isGrantedRead(s, 'Read', { file_path: '/Users/me/Downloads/report.pdf' })).toBe(true);
    expect(isGrantedRead(s, 'Read', { file_path: '/Users/me/Downloads/other.pdf' })).toBe(false);
  });

  test('bracketed paths keep spaces and parentheses', () => {
    const s = session();
    grantAttachedPaths(s, '[report (1).pdf · 88.0 KB](codiby-file:</Users/me/My Files/report (1).pdf>)');
    expect(isGrantedRead(s, 'Read', { file_path: '/Users/me/My Files/report (1).pdf' })).toBe(true);
  });

  test('never grants write tools', () => {
    const s = session();
    grantAttachedPaths(s, '[a.bin · 1 KB](codiby-file:/tmp/a.bin)');
    expect(isGrantedRead(s, 'Write', { file_path: '/tmp/a.bin' })).toBe(false);
    expect(isGrantedRead(s, 'Edit', { file_path: '/tmp/a.bin' })).toBe(false);
  });

  test('folder links grant their subtree only', () => {
    const s = session();
    grantAttachedPaths(s, '[logs/ · folder](codiby-file:/var/app/logs/)');
    expect(isGrantedRead(s, 'Grep', { path: '/var/app/logs' })).toBe(true);
    expect(isGrantedRead(s, 'Read', { file_path: '/var/app/logs/2026/a.log' })).toBe(true);
    expect(isGrantedRead(s, 'Read', { file_path: '/var/app/logs-old/a.log' })).toBe(false);
    expect(isGrantedRead(s, 'Read', { file_path: '/var/app/logs/../secrets' })).toBe(false);
  });

  test('covers saved snippets and ignores relative links', () => {
    const s = session();
    grantAttachedPaths(s, '[snippet-ab12.ts · 40 líneas](codiby-snippet:/Users/me/.codiby/s1/ab12.ts) [x](codiby-file:rel/x)');
    expect(isGrantedRead(s, 'Read', { file_path: '/Users/me/.codiby/s1/ab12.ts' })).toBe(true);
    expect(s.grantedReadPaths?.size).toBe(1);
  });
});
