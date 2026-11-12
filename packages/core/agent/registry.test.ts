import { describe, expect, test } from 'bun:test';
import { createAgentLifecycle } from './registry';

/** A lifecycle whose start blocks on a promise the test releases, recording what ran. */
function harness() {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const lifecycle = createAgentLifecycle(
    async () => {
      events.push('start:channels');
      await gate; // a Telegram bot's getMe, still out
      events.push('start:timers');
    },
    async () => { events.push('stop'); },
  );
  return { events, release, lifecycle };
}

describe('agent lifecycle', () => {
  test('a disable saved while a start hook awaits runs after the whole start, and leaves the agent off', async () => {
    const { events, release, lifecycle } = harness();
    let enabled = true;
    const on = lifecycle.sync(() => enabled);
    await Promise.resolve();
    enabled = false;
    const off = lifecycle.sync(() => enabled);
    release();
    await Promise.all([on, off]);
    // Before: stop ran mid-start and the timers armed afterwards, on an agent that was off.
    expect(events).toEqual(['start:channels', 'start:timers', 'stop']);
    expect(lifecycle.isUp()).toBe(false);
  });

  test('on, off, on in a burst starts once and never stops', async () => {
    const { events, release, lifecycle } = harness();
    let enabled = true;
    const calls = [lifecycle.sync(() => enabled)];
    enabled = false;
    calls.push(lifecycle.sync(() => enabled));
    enabled = true;
    calls.push(lifecycle.sync(() => enabled));
    release();
    await Promise.all(calls);
    expect(events).toEqual(['start:channels', 'start:timers']);
    expect(lifecycle.isUp()).toBe(true);
  });

  test('sync is a no-op when the areas already match, and runs beforeStart only on a real start', async () => {
    const { events, release, lifecycle } = harness();
    release();
    let created = 0;
    await lifecycle.sync(() => false, () => { created++; });
    expect(events).toEqual([]);
    await lifecycle.sync(() => true, () => { created++; });
    await lifecycle.sync(() => true, () => { created++; });
    expect(created).toBe(1);
    expect(events).toEqual(['start:channels', 'start:timers']);
  });

  test('direct start/stop (the e2e harness) keep the state sync compares against', async () => {
    const { events, release, lifecycle } = harness();
    release();
    await lifecycle.start();
    await lifecycle.sync(() => true);
    await lifecycle.stop();
    await lifecycle.sync(() => false);
    expect(events).toEqual(['start:channels', 'start:timers', 'stop']);
  });

  test('a hook that throws does not wedge the queue', async () => {
    const events: string[] = [];
    let fail = true;
    const lifecycle = createAgentLifecycle(
      async () => { if (fail) { fail = false; throw new Error('boom'); } events.push('start'); },
      async () => { events.push('stop'); },
    );
    await expect(lifecycle.start()).rejects.toThrow('boom');
    await lifecycle.stop();
    await lifecycle.sync(() => true);
    expect(events).toEqual(['stop', 'start']);
  });
});
