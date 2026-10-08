import { describe, expect, test } from 'bun:test';
import { callbackPortOf, parseAuthStatus, parseLoginCode } from './claude-auth';

describe('parseLoginCode', () => {
  test('splits the code#state shown on the platform page', () => {
    expect(parseLoginCode('  abc123#st4te \n')).toEqual({ code: 'abc123', state: 'st4te' });
  });

  test('accepts the full redirect URL', () => {
    expect(parseLoginCode('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz'))
      .toEqual({ code: 'abc', state: 'xyz' });
  });

  test('rejects input without both halves', () => {
    expect(parseLoginCode('abc123')).toBeNull();
    expect(parseLoginCode('#state')).toBeNull();
    expect(parseLoginCode('code#')).toBeNull();
    expect(parseLoginCode('https://platform.claude.com/oauth/code/callback?code=abc')).toBeNull();
  });
});

describe('callbackPortOf', () => {
  test('reads the port from the localhost redirect_uri', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A51066%2Fcallback&state=s';
    expect(callbackPortOf(url)).toBe(51066);
  });

  test('null when the redirect has no explicit port', () => {
    const url = 'https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';
    expect(callbackPortOf(url)).toBeNull();
  });
});

describe('parseAuthStatus', () => {
  test('maps `claude auth status --json`', () => {
    const json = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', orgName: 'Org', subscriptionType: 'max' });
    expect(parseAuthStatus(json)).toEqual({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', orgName: 'Org', subscriptionType: 'max',
    });
  });

  test('signed out or unparseable output is loggedIn=false', () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}').loggedIn).toBe(false);
    expect(parseAuthStatus('not json').loggedIn).toBe(false);
  });
});
