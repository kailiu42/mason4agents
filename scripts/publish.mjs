#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const packOnly = args.has("--pack");
const dryRun = args.has("--dry-run");

if (packOnly && dryRun) {
  fail("Use either --pack or --dry-run, not both.");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

run("bun", ["run", "verify"]);
run("bun", ["run", "build"]);

const nativeBinary = join("native", `mason4agents-${process.platform}-${normalizeArch(process.arch)}${process.platform === "win32" ? ".exe" : ""}`);
const requiredFiles = [
  "dist/bin/mason4agents.js",
  "dist/pi/extension.js",
  nativeBinary,
  "package.json",
];

ensureFile("dist/bin/mason4agents.js", true);
ensureFile("dist/pi/extension.js", false);
ensureFile(nativeBinary, true);
verifyPackIncludes(requiredFiles);

if (packOnly) {
  run("npm", ["pack"]);
} else {
  const publishArgs = ["publish"];
  if (typeof pkg.name === "string" && pkg.name.startsWith("@")) {
    publishArgs.push("--access", "public");
  }
  if (dryRun) {
    publishArgs.push("--dry-run");
  }
  run("npm", publishArgs);
}

function normalizeArch(arch) {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return arch;
}

function run(command, commandArgs) {
  console.log(`\n> ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  exitOnFailure(command, result);
}

function capture(command, commandArgs) {
  console.log(`\n> ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  exitOnFailure(command, result);
  return result.stdout;
}

function exitOnFailure(command, result) {
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.signal) {
    fail(`${command} terminated by signal ${result.signal}.`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureFile(relativePath, executable) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    fail(`Missing required publish artifact: ${relativePath}`);
  }
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    fail(`Publish artifact is not a file: ${relativePath}`);
  }
  if (!executable || process.platform === "win32") {
    return;
  }
  try {
    accessSync(absolutePath, constants.X_OK);
  } catch {
    chmodSync(absolutePath, stat.mode | 0o111);
    accessSync(absolutePath, constants.X_OK);
  }
}

function verifyPackIncludes(required) {
  const output = capture("npm", ["pack", "--dry-run", "--json"]);
  let packs;
  try {
    packs = JSON.parse(output);
  } catch (error) {
    fail(`Unable to parse npm pack --json output: ${error.message}`);
  }
  const files = new Set(packs.flatMap((pack) => (pack.files ?? []).map((file) => file.path)));
  const missing = required.filter((file) => !files.has(file));
  if (missing.length > 0) {
    fail(`npm package is missing required files:\n${missing.map((file) => `  - ${file}`).join("\n")}`);
  }
  console.log(`npm package dry-run includes required artifacts for ${process.platform}-${process.arch}.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
