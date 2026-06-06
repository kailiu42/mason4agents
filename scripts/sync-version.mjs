#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (isMain(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2));
}

export function main(argv) {
  const options = parseArgs(argv);
  const root = resolve(options.root);
  const version = packageVersion(root);
  const updates = versionUpdates(root, version);
  const changed = updates.filter((update) => update.current !== update.next);

  if (options.check) {
    if (changed.length > 0) {
      fail(`Version files are out of sync with package.json ${version}:\n${changed.map((update) => `  - ${update.label}`).join("\n")}`);
    }
    console.log(`Version files are in sync: ${version}`);
    return;
  }

  for (const update of changed) {
    writeFileSync(update.path, update.next);
    console.log(`Updated ${update.label} -> ${version}`);
  }
  if (changed.length === 0) {
    console.log(`Version files are already in sync: ${version}`);
  }
}

export function packageVersion(root) {
  const packageJsonPath = join(root, "package.json");
  const pkg = readJson(packageJsonPath);
  if (pkg.name !== "mason4agents") fail(`Expected package.json name mason4agents, found ${String(pkg.name)}`);
  if (typeof pkg.version !== "string" || !SEMVER_RE.test(pkg.version)) {
    fail(`package.json version must be a semver string, found ${String(pkg.version)}`);
  }
  return pkg.version;
}

export function versionUpdates(root, version) {
  const cargoTomlPath = join(root, "crates", "mason4agents", "Cargo.toml");
  const cargoLockPath = join(root, "Cargo.lock");
  const tuiPath = join(root, "src", "tui", "mason-tui.ts");
  const cargoToml = readText(cargoTomlPath);
  const cargoLock = readText(cargoLockPath);
  const tui = readText(tuiPath);
  return [
    {
      label: "crates/mason4agents/Cargo.toml",
      path: cargoTomlPath,
      current: cargoToml,
      next: syncCargoToml(cargoToml, version),
    },
    {
      label: "Cargo.lock",
      path: cargoLockPath,
      current: cargoLock,
      next: syncCargoLock(cargoLock, version),
    },
    {
    label: "src/tui/mason-tui.ts",
    path: tuiPath,
    current: tui,
    next: syncTuiVersion(tui, version),
    },
  ];
}

export function syncCargoToml(content, version) {
  const headerMatch = /^\[package\]\s*$/m.exec(content);
  if (!headerMatch) fail("crates/mason4agents/Cargo.toml is missing a [package] section.");

  const bodyStart = headerMatch.index + headerMatch[0].length;
  const nextSectionMatch = /^\[/m.exec(content.slice(bodyStart));
  const bodyEnd = nextSectionMatch ? bodyStart + nextSectionMatch.index : content.length;
  const body = content.slice(bodyStart, bodyEnd);
  const versionLine = /^version\s*=\s*"[^"]+"\s*$/m;
  if (!versionLine.test(body)) fail("crates/mason4agents/Cargo.toml [package] section is missing version.");
  const nextBody = body.replace(versionLine, `version = "${version}"`);

  return `${content.slice(0, bodyStart)}${nextBody}${content.slice(bodyEnd)}`;
}

export function syncCargoLock(content, version) {
  const packageBlock = /(^\[\[package\]\]\n[\s\S]*?)(?=^\[\[package\]\]|(?![\s\S]))/gm;
  let updated = content;
  let found = false;
  for (const match of content.matchAll(packageBlock)) {
    const block = match[1];
    if (!/^name\s*=\s*"mason4agents"\s*$/m.test(block)) continue;
    found = true;
    const versionLine = /^version\s*=\s*"[^"]+"\s*$/m;
    if (!versionLine.test(block)) fail("Cargo.lock mason4agents package block is missing version.");
    const nextBlock = block.replace(versionLine, `version = "${version}"`);
    updated = `${content.slice(0, match.index)}${nextBlock}${content.slice(match.index + block.length)}`;
    break;
  }
  if (!found) fail("Cargo.lock is missing the mason4agents package block.");
  return updated;
}

export function syncTuiVersion(content, version) {
  const versionLine = /^const MASON4AGENTS_VERSION = "[^"]+";$/m;
  if (!versionLine.test(content)) fail("src/tui/mason-tui.ts is missing MASON4AGENTS_VERSION.");
  return content.replace(versionLine, `const MASON4AGENTS_VERSION = "${version}";`);
}

function parseArgs(argv) {
  const options = { root: defaultRoot, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--root") options.root = requireValue(argv, ++index, arg);
    else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
  return value;
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  if (!existsSync(path)) fail(`Missing required version file: ${path}`);
  return readFileSync(path, "utf8");
}

function isMain(importMetaUrl, argvEntry) {
  return Boolean(argvEntry) && importMetaUrl === pathToFileURL(argvEntry).href;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
