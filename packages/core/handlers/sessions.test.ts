import { expect, test } from 'bun:test';
import { handleCreateSession } from './sessions';
import { sessions } from '../session/sessions';
import { setBridgeDeps } from '../provider/lifecycle';
import { registerProvider } from '../provider/registry';

test('failed provider creation returns its cause and leaves no ghost session', async () => {
  setBridgeDeps({ broadcastToSession() {}, broadcastSessionList() {}, sendBrowserRequest() {}, notifyTelegramIfMainSession() {} });
  registerProvider({ name: 'broken-test', spawn() { throw new Error('CLI missing'); } });
  const before = [...sessions.keys()];
  for (let i = 0; i < 2; i++) {
    const response = await handleCreateSession(new Request('http://localhost/sessions', { method: 'POST', body: JSON.stringify({ provider: 'broken-test', cwd: '/tmp' }) }), 3111);
    expect(response.status).toBe(503);
    expect((await response.json() as any).error).toContain('CLI missing');
    expect([...sessions.keys()]).toEqual(before);
  }
});
