#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const NATIVE_PACKAGES = Object.freeze([
  Object.freeze({
    key: "linux-x64-gnu",
    name: "mason4agents-linux-x64-gnu",
    artifact: "mason4agents-linux-x64-gnu",
    legacyArtifact: "mason4agents-linux-x64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    executable: "mason4agents",
  }),
  Object.freeze({
    key: "linux-arm64-gnu",
    name: "mason4agents-linux-arm64-gnu",
    artifact: "mason4agents-linux-arm64-gnu",
    legacyArtifact: "mason4agents-linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    executable: "mason4agents",
  }),
  Object.freeze({
    key: "darwin-x64",
    name: "mason4agents-darwin-x64",
    artifact: "mason4agents-darwin-x64",
    legacyArtifact: "mason4agents-darwin-x64",
    os: "darwin",
    cpu: "x64",
    executable: "mason4agents",
  }),
  Object.freeze({
    key: "darwin-arm64",
    name: "mason4agents-darwin-arm64",
    artifact: "mason4agents-darwin-arm64",
    legacyArtifact: "mason4agents-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    executable: "mason4agents",
  }),
  Object.freeze({
    key: "win32-x64",
    name: "mason4agents-win32-x64",
    artifact: "mason4agents-win32-x64.exe",
    legacyArtifact: "mason4agents-win32-x64.exe",
    os: "win32",
    cpu: "x64",
    executable: "mason4agents.exe",
  }),
  Object.freeze({
    key: "win32-arm64",
    name: "mason4agents-win32-arm64",
    artifact: "mason4agents-win32-arm64.exe",
    legacyArtifact: "mason4agents-win32-arm64.exe",
    os: "win32",
    cpu: "arm64",
    executable: "mason4agents.exe",
  }),
]);

if (isMain(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2));
}

export function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const root = resolve(options.root);
  const pkg = readPackage(root);
  verifyTagVersion(pkg, env);

  if (options.copyLocalNative) {
    copyLocalNative(root, options.platform);
    return;
  }

  const selectedPackages = selectNativePackages(options.platform, options.pack);
  if (!options.pack && selectedPackages.length !== NATIVE_PACKAGES.length) {
    fail("npm publish and publish dry-runs require all native packages; use --pack --platform current only for local install testing.");
  }

  const artifactDir = resolve(root, options.artifactDir);
  const outDir = resolve(root, options.outDir);
  const staged = stagePackages({ root, pkg, artifactDir, outDir, nativePackages: selectedPackages });
  verifyStagedPackages(staged);

  if (options.pack) {
    packStagedPackages(staged, join(outDir, "tarballs"));
    return;
  }

  publishStagedPackages(staged, { dryRun: options.dryRun, provenance: options.provenance });
}

export function createRootPackageManifest(pkg, nativePackages = NATIVE_PACKAGES) {
  const manifest = pickDefined({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    license: pkg.license,
    repository: pkg.repository,
    bin: pkg.bin,
    keywords: pkg.keywords,
    omp: pkg.omp,
    pi: pkg.pi,
    dependencies: pkg.dependencies,
    optionalDependencies: optionalDependenciesFor(pkg.version, nativePackages),
    files: ["dist/bin/mason4agents.js", "dist/pi/extension.js", "LICENSE", "README.md", "package.json"],
  });
  return manifest;
}

export function createNativePackageManifest(pkg, nativePackage) {
  return pickDefined({
    name: nativePackage.name,
    version: pkg.version,
    description: `${pkg.description} Native binary for ${nativePackage.os}/${nativePackage.cpu}${nativePackage.libc ? `/${nativePackage.libc}` : ""}.`,
    license: pkg.license,
    repository: pkg.repository,
    os: [nativePackage.os],
    cpu: [nativePackage.cpu],
    libc: nativePackage.libc ? [nativePackage.libc] : undefined,
    files: [`bin/${nativePackage.executable}`, "LICENSE", "package.json"],
  });
}

export function optionalDependenciesFor(version, nativePackages = NATIVE_PACKAGES) {
  return Object.fromEntries(nativePackages.map((nativePackage) => [nativePackage.name, version]));
}

export function selectNativePackages(selector = "all", allowCurrent = false) {
  if (selector === "all") return [...NATIVE_PACKAGES];
  if (selector === "current") {
    if (!allowCurrent) fail("--platform current is only supported with --pack or --copy-local-native.");
    const current = currentNativePackage();
    if (!current) fail(`Current platform is not supported for native package publishing: ${process.platform}/${process.arch}.`);
    return [current];
  }
  const selected = NATIVE_PACKAGES.find((nativePackage) => nativePackage.key === selector || nativePackage.name === selector);
  if (!selected) fail(`Unknown native package platform '${selector}'. Expected one of: all, current, ${NATIVE_PACKAGES.map((nativePackage) => nativePackage.key).join(", ")}.`);
  return [selected];
}

export function stagePackages({ root, pkg, artifactDir, outDir, nativePackages }) {
  assertSafeOutputDirectory(root, outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const native = nativePackages.map((nativePackage) => stageNativePackage(root, pkg, artifactDir, outDir, nativePackage));
  const rootPackage = stageRootPackage(root, pkg, outDir, nativePackages);
  return { root, pkg, outDir, rootPackage, native };
}

function stageRootPackage(root, pkg, outDir, nativePackages) {
  const packageDir = join(outDir, "staging", "mason4agents");
  mkdirSync(packageDir, { recursive: true });
  copyRequiredFile(join(root, "dist", "bin", "mason4agents.js"), join(packageDir, "dist", "bin", "mason4agents.js"));
  copyRequiredFile(join(root, "dist", "pi", "extension.js"), join(packageDir, "dist", "pi", "extension.js"));
  copyRequiredFile(join(root, "LICENSE"), join(packageDir, "LICENSE"));
  copyRequiredFile(join(root, "README.md"), join(packageDir, "README.md"));
  writeJson(join(packageDir, "package.json"), createRootPackageManifest(pkg, nativePackages));
  return {
    kind: "root",
    name: pkg.name,
    packageDir,
    requiredFiles: ["package.json", "LICENSE", "README.md", "dist/bin/mason4agents.js", "dist/pi/extension.js"],
    exactFiles: undefined,
  };
}

function stageNativePackage(root, pkg, artifactDir, outDir, nativePackage) {
  const packageDir = join(outDir, "staging", nativePackage.name);
  const source = findNativeBinarySource(artifactDir, nativePackage);
  const executablePath = join(packageDir, "bin", nativePackage.executable);
  mkdirSync(dirname(executablePath), { recursive: true });
  ensureNativeBinary(source, nativePackage);
  copyFileSync(source, executablePath);
  if (nativePackage.os !== "win32") {
    const mode = statSync(executablePath).mode;
    chmodSync(executablePath, mode | 0o755);
  }
  copyRequiredFile(join(root, "LICENSE"), join(packageDir, "LICENSE"));
  writeJson(join(packageDir, "package.json"), createNativePackageManifest(pkg, nativePackage));
  return {
    kind: "native",
    name: nativePackage.name,
    packageDir,
    nativePackage,
    requiredFiles: ["package.json", "LICENSE", `bin/${nativePackage.executable}`],
    exactFiles: ["package.json", "LICENSE", `bin/${nativePackage.executable}`],
  };
}

function verifyStagedPackages(staged) {
  for (const nativePackage of staged.native) {
    verifyNativeManifest(nativePackage);
    verifyPackIncludes(nativePackage);
  }
  verifyRootManifest(staged.rootPackage, staged.pkg.version, staged.native.map((entry) => entry.nativePackage));
  verifyPackIncludes(staged.rootPackage, ["native/", "dist/npm/"]);
}

function verifyRootManifest(rootPackage, version, nativePackages) {
  const manifest = readJson(join(rootPackage.packageDir, "package.json"));
  const expected = optionalDependenciesFor(version, nativePackages);
  const actual = manifest.optionalDependencies ?? {};
  const missing = Object.entries(expected).filter(([name, dependencyVersion]) => actual[name] !== dependencyVersion);
  if (missing.length > 0) {
    fail(`Root package optionalDependencies are not pinned to ${version}: ${missing.map(([name]) => name).join(", ")}`);
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) fail(`Root package has unexpected optionalDependency: ${name}`);
  }
}

function verifyNativeManifest(stagedPackage) {
  const manifest = readJson(join(stagedPackage.packageDir, "package.json"));
  const nativePackage = stagedPackage.nativePackage;
  if (manifest.bin !== undefined) fail(`${nativePackage.name} must not declare a bin field.`);
  if (!Array.isArray(manifest.os) || manifest.os[0] !== nativePackage.os || manifest.os.length !== 1) {
    fail(`${nativePackage.name} must set os to ${nativePackage.os}.`);
  }
  if (!Array.isArray(manifest.cpu) || manifest.cpu[0] !== nativePackage.cpu || manifest.cpu.length !== 1) {
    fail(`${nativePackage.name} must set cpu to ${nativePackage.cpu}.`);
  }
  if (nativePackage.libc) {
    if (!Array.isArray(manifest.libc) || manifest.libc[0] !== nativePackage.libc || manifest.libc.length !== 1) {
      fail(`${nativePackage.name} must set libc to ${nativePackage.libc}.`);
    }
  } else if (manifest.libc !== undefined) {
    fail(`${nativePackage.name} must not set libc.`);
  }
}

function verifyPackIncludes(stagedPackage, forbiddenPrefixes = []) {
  const output = capture("npm", ["pack", "--dry-run", "--json"], stagedPackage.packageDir);
  const packs = parseNpmJson(output, "npm pack --dry-run --json");
  const files = new Set(packs.flatMap((pack) => (pack.files ?? []).map((file) => file.path)));
  const missing = stagedPackage.requiredFiles.filter((file) => !files.has(file));
  if (missing.length > 0) {
    fail(`${stagedPackage.name} package is missing required files:\n${missing.map((file) => `  - ${file}`).join("\n")}`);
  }
  for (const prefix of forbiddenPrefixes) {
    const forbidden = [...files].filter((file) => file.startsWith(prefix));
    if (forbidden.length > 0) fail(`${stagedPackage.name} package includes forbidden files under ${prefix}: ${forbidden.join(", ")}`);
  }
  if (stagedPackage.exactFiles) {
    const expected = new Set(stagedPackage.exactFiles);
    const unexpected = [...files].filter((file) => !expected.has(file));
    if (unexpected.length > 0) fail(`${stagedPackage.name} package includes unexpected files: ${unexpected.join(", ")}`);
  }
}

function packStagedPackages(staged, tarballDir) {
  rmSync(tarballDir, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });
  for (const stagedPackage of [...staged.native, staged.rootPackage]) {
    const output = capture("npm", ["pack", "--json", "--pack-destination", tarballDir], stagedPackage.packageDir);
    const packs = parseNpmJson(output, "npm pack --json");
    for (const pack of packs) {
      console.log(`Packed ${stagedPackage.name}: ${pack.filename ?? pack.name}`);
    }
  }
  console.log(`Tarballs written to ${tarballDir}`);
}

export function npmPublishArgs(packageDir, { dryRun, provenance }) {
  const args = ["publish", packageDir];
  if (dryRun) args.push("--dry-run");
  if (provenance) args.push("--provenance", "--access", "public");
  return args;
}

function publishStagedPackages(staged, { dryRun, provenance }) {
  for (const stagedPackage of [...staged.native, staged.rootPackage]) {
    if (!dryRun && packageVersionExists(stagedPackage.name, staged.pkg.version, staged.root)) {
      console.log(`Skipping ${stagedPackage.name}@${staged.pkg.version}; already published.`);
      continue;
    }
    const args = npmPublishArgs(stagedPackage.packageDir, { dryRun, provenance });
    run("npm", args, staged.root);
  }
}

function packageVersionExists(name, version, cwd) {
  const spec = `${name}@${version}`;
  console.log(`\n> npm view ${spec} version`);
  const result = spawnSync("npm", ["view", spec, "version"], {
    cwd,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status === 0) {
    return result.stdout.trim() === version;
  }
  if (result.stderr?.includes("E404") || result.stderr?.includes("404 Not Found")) {
    return false;
  }
  if (result.stderr) process.stderr.write(result.stderr);
  exitOnFailure("npm", result);
  return false;
}

function copyLocalNative(root, selector) {
  const selected = selectNativePackages(selector === "all" ? "current" : selector, true);
  if (selected.length !== 1) fail("--copy-local-native can only copy one current native package.");
  const nativePackage = selected[0];
  if (nativePackage.os !== process.platform || nativePackage.cpu !== normalizeArch(process.arch)) {
    fail(`--copy-local-native target ${nativePackage.key} does not match current runtime ${process.platform}/${process.arch}.`);
  }
  const source = join(root, "target", "release", nativePackage.executable);
  ensureNativeBinary(source, nativePackage);
  const nativeDir = join(root, "native");
  mkdirSync(nativeDir, { recursive: true });
  const targets = new Set([nativePackage.artifact, nativePackage.legacyArtifact].filter(Boolean));
  for (const artifactName of targets) {
    const target = join(nativeDir, artifactName);
    copyFileSync(source, target);
    if (nativePackage.os !== "win32") chmodSync(target, statSync(target).mode | 0o755);
    console.log(`Copied ${relative(root, source)} -> ${relative(root, target)}`);
  }
}

function findNativeBinarySource(artifactDir, nativePackage) {
  const candidates = [
    join(artifactDir, nativePackage.artifact),
    join(artifactDir, nativePackage.name, nativePackage.artifact),
    join(artifactDir, nativePackage.artifact, nativePackage.artifact),
    join(artifactDir, "native", nativePackage.artifact),
  ];
  if (nativePackage.legacyArtifact && nativePackage.legacyArtifact !== nativePackage.artifact) {
    candidates.push(join(artifactDir, nativePackage.legacyArtifact));
    candidates.push(join(artifactDir, "native", nativePackage.legacyArtifact));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail(`Missing native binary for ${nativePackage.name}. Checked:\n${candidates.map((candidate) => `  - ${candidate}`).join("\n")}`);
}

function ensureNativeBinary(filePath, nativePackage) {
  if (!existsSync(filePath)) fail(`Missing native binary: ${filePath}`);
  const stat = statSync(filePath);
  if (!stat.isFile()) fail(`Native binary is not a file: ${filePath}`);
  if (nativePackage.os === "win32") return;
  try {
    accessSync(filePath, constants.X_OK);
  } catch {
    chmodSync(filePath, stat.mode | 0o111);
    accessSync(filePath, constants.X_OK);
  }
}

function parseArgs(argv) {
  const options = {
    root: defaultRoot,
    artifactDir: "native",
    outDir: join("dist", "npm"),
    platform: "all",
    pack: false,
    dryRun: false,
    copyLocalNative: false,
    provenance: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pack") options.pack = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--copy-local-native") options.copyLocalNative = true;
    else if (arg === "--provenance") options.provenance = true;
    else if (arg === "--root") options.root = requireValue(argv, ++index, arg);
    else if (arg === "--artifacts" || arg === "--artifact-dir") options.artifactDir = requireValue(argv, ++index, arg);
    else if (arg === "--out-dir") options.outDir = requireValue(argv, ++index, arg);
    else if (arg === "--platform") options.platform = requireValue(argv, ++index, arg);
    else fail(`Unknown argument: ${arg}`);
  }
  if (options.pack && options.dryRun) fail("Use either --pack or --dry-run, not both.");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
  return value;
}

function readPackage(root) {
  const pkg = readJson(join(root, "package.json"));
  if (pkg.name !== "mason4agents") fail(`Expected root package name mason4agents, found ${pkg.name}.`);
  if (typeof pkg.version !== "string" || pkg.version.length === 0) fail("Root package.json must have a version.");
  return pkg;
}

function verifyTagVersion(pkg, env) {
  const refName = env.GITHUB_REF_NAME ?? (env.GITHUB_REF?.startsWith("refs/tags/") ? env.GITHUB_REF.slice("refs/tags/".length) : undefined);
  if (!refName || env.GITHUB_REF_TYPE === "branch") return;
  const expected = `v${pkg.version}`;
  if (refName !== expected) fail(`Git tag ${refName} does not match package.json version ${pkg.version}; expected ${expected}.`);
}

function currentNativePackage() {
  const arch = normalizeArch(process.arch);
  if (process.platform === "linux") return NATIVE_PACKAGES.find((nativePackage) => nativePackage.key === `linux-${arch}-gnu`);
  return NATIVE_PACKAGES.find((nativePackage) => nativePackage.os === process.platform && nativePackage.cpu === arch);
}

function normalizeArch(arch) {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return arch;
}

function copyRequiredFile(source, target) {
  if (!existsSync(source)) fail(`Missing required publish artifact: ${source}`);
  const stat = statSync(source);
  if (!stat.isFile()) fail(`Publish artifact is not a file: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pickDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function assertSafeOutputDirectory(root, outDir) {
  const resolvedRoot = resolve(root);
  const resolvedOut = resolve(outDir);
  const rootFromOut = relative(resolvedOut, resolvedRoot);
  const outContainsRoot = rootFromOut === "" || (!rootFromOut.startsWith("..") && !isAbsolute(rootFromOut));
  if (resolvedOut === resolve("/") || resolvedOut.length < 8 || outContainsRoot) {
    fail(`Refusing unsafe output directory: ${outDir}`);
  }
}

function run(command, commandArgs, cwd) {
  console.log(`\n> ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  exitOnFailure(command, result);
}

function capture(command, commandArgs, cwd) {
  console.log(`\n> ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.stderr) process.stderr.write(result.stderr);
  exitOnFailure(command, result);
  return result.stdout;
}

function exitOnFailure(command, result) {
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.signal) fail(`${command} terminated by signal ${result.signal}.`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseNpmJson(output, command) {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    fail(`Unable to parse ${command} output: ${error.message}`);
  }
}

function isMain(importMetaUrl, argvEntry) {
  return Boolean(argvEntry) && importMetaUrl === pathToFileURL(argvEntry).href;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
