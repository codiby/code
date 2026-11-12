import { describe, expect, test } from 'bun:test';
import { createResponseOrder, discoverAgentHost } from './polled';

describe('agent host discovery', () => {
  test('the first host with the agent enabled wins; unreachable ones are skipped', async () => {
    const enabled: Record<string, boolean | Error> = { local: false, laptop: new Error('timeout'), ryzen9: true };
    const probe = async (h: string) => { const v = enabled[h]; if (v instanceof Error) throw v; return !!v; };
    expect(await discoverAgentHost(['local', 'laptop', 'ryzen9'], probe, () => true, 'local')).toEqual({ host: 'ryzen9' });
    expect(await discoverAgentHost(['local', 'laptop'], probe, () => true, 'local')).toEqual({ host: 'local' });
  });

  test('a host picked from the menu while remotes are still being probed is not overwritten', async () => {
    let picked = false;
    const probe = async (h: string) => {
      if (h === 'local') picked = true; // the owner chooses while this probe is out
      return h === 'ryzen9';
    };
    expect(await discoverAgentHost(['local', 'ryzen9'], probe, () => !picked, 'local')).toBeNull();
  });
});

describe('polled section response order', () => {
  test('an older response that lands after a newer one is dropped', () => {
    const order = createResponseOrder();
    const caf = order.begin();
    const cafe = order.begin();
    expect(cafe.accept()).toBe(true);
    // "caf"'s results arrive last: they must not replace "cafe"'s.
    expect(caf.accept()).toBe(false);
  });

  test('overlapping polls on a slow host still update: in-order responses are all shown', () => {
    const order = createResponseOrder();
    const first = order.begin();
    const second = order.begin(); // the next poll started before the first answered
    expect(first.accept()).toBe(true);
    expect(second.accept()).toBe(true);
  });

  test('changed inputs or an unmount make every load still out stale', () => {
    const order = createResponseOrder();
    const before = order.begin();
    order.invalidate();
    const after = order.begin();
    expect(before.accept()).toBe(false);
    expect(after.accept()).toBe(true);
  });
});
