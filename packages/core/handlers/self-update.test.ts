import { describe, expect, it } from 'bun:test';
import { userUnitFromCgroup } from './self-update';

describe('userUnitFromCgroup', () => {
  it('finds the user unit', () => {
    expect(userUnitFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/codiby-code.service\n'))
      .toBe('codiby-code.service');
  });

  it('ignores system units, which `systemctl --user` cannot restart', () => {
    expect(userUnitFromCgroup('0::/system.slice/codiby-code.service\n')).toBeNull();
  });

  it('ignores a login shell', () => {
    expect(userUnitFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull();
  });

  it('is null off Linux', () => {
    expect(userUnitFromCgroup('')).toBeNull();
  });
});
