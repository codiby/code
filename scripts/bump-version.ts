#!/usr/bin/env bun
/**
 * Bump the app version in `package.json`. The Electron build reads its
 * version from here directly — no other files need to stay in sync.
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

console.log(`Bumped version: ${current} -> ${next}`);
console.log("Updated:");
console.log("  package.json");
