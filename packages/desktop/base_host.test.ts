import { describe, expect, test } from 'bun:test';
import { parseBaseConfig, toWslPath } from './base_host';
import { takeEvents } from './sse';

describe('parseBaseConfig', () => {
  test('a WSL base, as the installer writes it', () => {
    expect(parseBaseConfig('{"base":"WSL","distro":"Ubuntu","port":3112}')).toEqual({ distro: 'Ubuntu', port: 3112 });
  });
  test('a Windows base, a broken file or a bad distro is not a WSL base', () => {
    expect(parseBaseConfig('{"base":"Windows","distro":"Ubuntu","port":3112}')).toBeNull();
    expect(parseBaseConfig('not json')).toBeNull();
    expect(parseBaseConfig('{"base":"WSL","distro":"bad name; rm -rf"}')).toBeNull();
  });
  test('a missing or invalid port falls back to the default', () => {
    expect(parseBaseConfig('{"base":"WSL","distro":"Debian"}')).toEqual({ distro: 'Debian', port: 3112 });
    expect(parseBaseConfig('{"base":"WSL","distro":"Debian","port":"x"}')).toEqual({ distro: 'Debian', port: 3112 });
  });
});

describe('toWslPath', () => {
  test('a drive path goes under /mnt', () => {
    expect(toWslPath('C:\\Users\\Jovanny Rochin\\a.txt', 'Ubuntu')).toBe('/mnt/c/Users/Jovanny Rochin/a.txt');
    expect(toWslPath('D:\\', 'Ubuntu')).toBe('/mnt/d');
  });
  test("the base distro's own files lose the UNC prefix", () => {
    expect(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\jovaz\\src', 'Ubuntu')).toBe('/home/jovaz/src');
    expect(toWslPath('\\\\wsl$\\ubuntu\\etc\\hosts', 'Ubuntu')).toBe('/etc/hosts');
  });
  test("another distro's files and network shares are left alone", () => {
    expect(toWslPath('\\\\wsl.localhost\\Debian\\home\\x', 'Ubuntu')).toBe('\\\\wsl.localhost\\Debian\\home\\x');
    expect(toWslPath('\\\\server\\share\\x', 'Ubuntu')).toBe('\\\\server\\share\\x');
  });
});

describe('takeEvents', () => {
  test('splits complete events, skips comments, keeps a partial one', () => {
    const { events, rest } = takeEvents(': ok\n\ndata: {"a":1}\n\ndata: {"b"');
    expect(events).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b"');
    expect(takeEvents(`${rest}:2}\n\n`).events).toEqual(['{"b":2}']);
  });
});
