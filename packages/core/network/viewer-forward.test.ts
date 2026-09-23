import { describe, expect, test } from 'bun:test';
import { handleViewerForwardResponse, requestViewerForward } from './viewer-forward';

/** Captures the request the bridge sends so a test can answer it. */
function viewer(reached = 1) {
  const sent: any[] = [];
  const send = (_sessionId: string, msg: object) => { sent.push(msg); return reached; };
  return {
    send,
    sent,
    get requestId(): string { return sent[0]?.requestId; },
    answer(payload: { localPort?: number; unsupported?: boolean; error?: string }) {
      handleViewerForwardResponse({ requestId: this.requestId, ...payload });
    },
  };
}

describe('requestViewerForward', () => {
  test('resolves with the port the viewer opened', async () => {
    const v = viewer();
    const pending = requestViewerForward('s1', 4322, 'astro dev', v.send);
    v.answer({ localPort: 4322 });
    expect(await pending).toEqual({ ok: true, localPort: 4322 });
  });

  test('carries the port and label to the viewer', async () => {
    const v = viewer();
    const pending = requestViewerForward('s1', 4322, 'astro dev', v.send);
    expect(v.sent[0]).toMatchObject({
      type: 'remote_forward_request',
      sessionId: 's1',
      remotePort: 4322,
      label: 'astro dev',
    });
    v.answer({ localPort: 4322 });
    await pending;
  });

  test('settles as unsupported without waiting when no viewer got it', async () => {
    // A phone or a browser tab is subscribed but cannot open an `-L`; burning
    // the full timeout here would stall every forward on a web-only viewer.
    const v = viewer(0);
    expect(await requestViewerForward('s1', 4322, null, v.send)).toEqual({ ok: false, unsupported: true });
  });

  test('settles as unsupported when the viewer declines', async () => {
    const v = viewer();
    const pending = requestViewerForward('s1', 4322, null, v.send);
    v.answer({ unsupported: true });
    expect(await pending).toEqual({ ok: false, unsupported: true });
  });

  test('a reply with no port is a decline, not a forward on port undefined', async () => {
    const v = viewer();
    const pending = requestViewerForward('s1', 4322, null, v.send);
    v.answer({});
    expect(await pending).toEqual({ ok: false, unsupported: true });
  });

  test('rejects with the viewer\'s own reason', async () => {
    const v = viewer();
    const pending = requestViewerForward('s1', 4322, null, v.send);
    v.answer({ error: 'ssh: connect to host ryzen9 port 22: Connection refused' });
    expect(pending).rejects.toThrow('Connection refused');
  });

  test('rejects when the viewer never answers', async () => {
    const v = viewer();
    expect(requestViewerForward('s1', 4322, null, v.send, 20)).rejects.toThrow('did not answer');
  });

  test('a late or unknown response is ignored rather than crashing', () => {
    expect(() => handleViewerForwardResponse({ requestId: 'never-issued', localPort: 1 })).not.toThrow();
    expect(() => handleViewerForwardResponse({ localPort: 1 })).not.toThrow();
  });

  test('answering twice does not settle a second request', async () => {
    const v = viewer();
    const pending = requestViewerForward('s1', 4322, null, v.send);
    v.answer({ localPort: 4322 });
    expect(await pending).toEqual({ ok: true, localPort: 4322 });
    // The id is gone from the pending map; a duplicate is a no-op.
    expect(() => v.answer({ localPort: 9999 })).not.toThrow();
  });
});
