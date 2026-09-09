/** Copy the SDK's pinned native CLI beside server.js; no runtime npm lookup. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';

const output = process.argv[2];
if (!output) throw new Error('Usage: bun scripts/bundle-codex.ts <output-directory>');
const targets: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`Unsupported Codex platform: ${process.platform}-${process.arch}`);
const sdkEntry = import.meta.resolve('../packages/core/node_modules/@openai/codex-sdk/dist/index.js');
const sdkRequire = createRequire(realpathSync(new URL(sdkEntry)));
const cliRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
const platformPackage = cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
const source = join(dirname(platformPackage), 'vendor', target);
await mkdir(output, { recursive: true });
// Keep the native package layout: the CLI also needs its code-mode host,
// shell resources and bundled search executable.
await cp(source, join(output, 'codex-runtime'), { recursive: true, force: true });
console.log(`Bundled Codex runtime: ${join(output, 'codex-runtime')}`);
