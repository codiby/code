import { describe, expect, test } from 'bun:test';
import { fromDateTimeLocal, isFinishedOnce, toDateTimeLocal } from '../automations';
import { buildHeartbeatCron, describeHeartbeatSchedule, parseHeartbeatCron } from './proactive';

describe('heartbeat schedule', () => {
  test('presets and active hours round-trip through cron', () => {
    expect(buildHeartbeatCron({ presetId: '1h', from: 8, to: 22 })).toBe('0 8-22 * * *');
    expect(buildHeartbeatCron({ presetId: '30m', from: 0, to: 23 })).toBe('*/30 * * * *');
    expect(buildHeartbeatCron({ presetId: '2h', from: 9, to: 17 })).toBe('0 9-17/2 * * *');
    for (const cron of ['0 8-22 * * *', '*/30 * * * *', '0 9-17/2 * * *', '0 */4 * * *']) {
      expect(buildHeartbeatCron(parseHeartbeatCron(cron)!)).toBe(cron);
    }
  });

  test('anything else is custom', () => {
    expect(parseHeartbeatCron('15 9 * * 1-5')).toBeNull();
    expect(parseHeartbeatCron('0 22-8 * * *')).toBeNull();
    expect(parseHeartbeatCron('0 8-22/3 * * *')).toBeNull();
  });

  test('describes the schedule in words', () => {
    expect(describeHeartbeatSchedule({ presetId: '1h', from: 8, to: 22 })).toBe('Hourly, 08:00–22:59');
    expect(describeHeartbeatSchedule({ presetId: '30m', from: 0, to: 23 })).toBe('Every 30 min, all day');
  });
});

describe('one-shot helpers', () => {
  test('datetime-local values round-trip in the browser zone', () => {
    const ts = new Date(2026, 10, 12, 9, 30).getTime();
    expect(toDateTimeLocal(ts)).toBe('2026-11-12T09:30');
    expect(fromDateTimeLocal('2026-11-12T09:30')).toBe(ts);
    expect(fromDateTimeLocal('')).toBeNull();
  });

  test('a fired one-shot reads as done, a paused future one does not', () => {
    const now = Date.now();
    expect(isFinishedOnce({ triggerType: 'once', enabled: false, runAt: now - 1 }, now)).toBe(true);
    expect(isFinishedOnce({ triggerType: 'once', enabled: false, runAt: now + 60_000 }, now)).toBe(false);
    expect(isFinishedOnce({ triggerType: 'cron', enabled: false, runAt: null }, now)).toBe(false);
  });
});
