#!/usr/bin/env bun
/**
 * Bump the app version across every file that hard-codes it:
 *   - package.json
 *   - src-tauri/Cargo.toml
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.lock        (only the `codiby-code` package entry)
 *
 * Usage:
 *   bun run scripts/bump-version.ts patch       # 0.0.1 -> 0.0.2
 *   bun run scripts/bump-version.ts minor       # 0.0.1 -> 0.1.0
 *   bun run scripts/bump-version.ts major       # 0.1.2 -> 1.0.0
 *   bun run scripts/bump-version.ts 1.2.3       # explicit version
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGE_JSON = resolve(ROOT, "package.json");
const CARGO_TOML = resolve(ROOT, "src-tauri/Cargo.toml");
const TAURI_CONF = resolve(ROOT, "src-tauri/tauri.conf.json");
const CARGO_LOCK = resolve(ROOT, "src-tauri/Cargo.lock");

type Bump = "major" | "minor" | "patch";

function parseSemver(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Not a valid x.y.z version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function bump(current: string, kind: Bump): string {
  const [maj, min, pat] = parseSemver(current);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function readCurrent(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string };
  return pkg.version;
}

function updatePackageJson(next: string) {
  const text = readFileSync(PACKAGE_JSON, "utf8");
  const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  writeFileSync(PACKAGE_JSON, updated);
}

function updateTauriConf(next: string) {
  const text = readFileSync(TAURI_CONF, "utf8");
  const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  writeFileSync(TAURI_CONF, updated);
}

function updateCargoToml(next: string) {
  const text = readFileSync(CARGO_TOML, "utf8");
  // Only the first `version = "..."` line, which sits inside [package].
  const updated = text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${next}"`);
  writeFileSync(CARGO_TOML, updated);
}

function updateCargoLock(next: string) {
  const text = readFileSync(CARGO_LOCK, "utf8");
  const updated = text.replace(
    /(name = "codiby-code"\nversion = ")[^"]+(")/,
    `$1${next}$2`,
  );
  if (updated === text) {
    throw new Error("Could not locate codiby-code entry in Cargo.lock");
  }
  writeFileSync(CARGO_LOCK, updated);
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: bun run scripts/bump-version.ts <patch|minor|major|x.y.z>");
  process.exit(1);
}

const current = readCurrent();
const next = ["patch", "minor", "major"].includes(arg)
  ? bump(current, arg as Bump)
  : (parseSemver(arg), arg);

updatePackageJson(next);
updateCargoToml(next);
updateTauriConf(next);
updateCargoLock(next);

console.log(`Bumped version: ${current} -> ${next}`);
console.log("Updated:");
console.log("  package.json");
console.log("  src-tauri/Cargo.toml");
console.log("  src-tauri/tauri.conf.json");
console.log("  src-tauri/Cargo.lock");
