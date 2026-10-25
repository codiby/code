import { foreignEntries, isWithin, resolveGroups } from '../src/lib/groupTree';

const session = (serverId: string, id: string) => ({
  key: `${serverId}:${id}`,
  id,
  serverId,
});

describe('resolveGroups', () => {
  it('usa el mapa del dueño cuando nadie más opina', () => {
    const groups = resolveGroups(
      [session('ryzen', 's1')],
      [{ serverId: 'ryzen', map: { s1: 'vtb' } }],
    );
    expect(groups).toEqual({ 'ryzen:s1': 'vtb' });
  });

  it('la entrada que guardó el escritorio de otra máquina manda', () => {
    const groups = resolveGroups(
      [session('mac', 'm1'), session('ryzen', 's1'), session('ryzen', 's2')],
      [
        { serverId: 'mac', map: { m1: 'code', s1: 'utilityprofit' } },
        { serverId: 'ryzen', map: { s1: 'otros', s2: 'vtb' } },
      ],
    );
    expect(groups).toEqual({
      'mac:m1': 'code',
      'ryzen:s1': 'utilityprofit',
      'ryzen:s2': 'vtb',
    });
  });

  it('ignora una entrada ajena si esa máquina tiene una sesión con ese id', () => {
    const groups = resolveGroups(
      [session('mac', 'x'), session('ryzen', 'x')],
      [
        { serverId: 'mac', map: { x: 'code' } },
        { serverId: 'ryzen', map: {} },
      ],
    );
    expect(groups).toEqual({ 'mac:x': 'code' });
  });
});

describe('foreignEntries', () => {
  it('dice qué máquina guarda el grupo ajeno de cada sesión', () => {
    const all = [session('mac', 'm1'), session('ryzen', 's1')];
    const entries = foreignEntries(
      [session('ryzen', 's1')],
      all,
      [
        { serverId: 'mac', map: { m1: 'code', s1: 'utilityprofit' } },
        { serverId: 'ryzen', map: { s1: 'otros' } },
      ],
    );
    expect([...entries]).toEqual([['mac', ['s1']]]);
  });
});

describe('isWithin', () => {
  it('reconoce subgrupos por su ruta y no por prefijo suelto', () => {
    expect(isWithin('utilityprofit/out of cycle', 'utilityprofit')).toBe(true);
    expect(isWithin('utilityprofit', 'utilityprofit')).toBe(true);
    expect(isWithin('utilityprofit2', 'utilityprofit')).toBe(false);
  });
});
