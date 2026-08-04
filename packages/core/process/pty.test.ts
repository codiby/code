import { expect, test } from 'bun:test';
import { spawnPty } from './pty';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test.skipIf(process.platform === 'win32')('shell accepts input after interrupting a foreground process', async () => {
  const pty = spawnPty({
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
    shell: '/bin/sh',
  });
  expect(pty).not.toBeNull();
  if (!pty) return;

  let output = '';
  pty.onData(text => { output += text; });

  try {
    await delay(300);
    pty.write('sleep 10\r');
    await delay(300);
    pty.write('\x03');
    await delay(300);
    pty.write('test -r /dev/tty && echo $((12345 + 67890))\r');

    const deadline = Date.now() + 2_000;
    while (!output.includes('80235') && Date.now() < deadline) await delay(20);
    expect(output).toContain('80235');
  } finally {
    pty.kill();
  }
}, 5_000);
