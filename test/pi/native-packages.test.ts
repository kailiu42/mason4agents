import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const publishScript = join(repoRoot, "scripts", "publish.mjs");

const nativePackages = [
  { name: "mason4agents-linux-x64-gnu", artifact: "mason4agents-linux-x64-gnu", os: "linux", cpu: "x64", libc: "glibc", executable: "mason4agents" },
  { name: "mason4agents-linux-arm64-gnu", artifact: "mason4agents-linux-arm64-gnu", os: "linux", cpu: "arm64", libc: "glibc", executable: "mason4agents" },
  { name: "mason4agents-darwin-x64", artifact: "mason4agents-darwin-x64", os: "darwin", cpu: "x64", executable: "mason4agents" },
  { name: "mason4agents-darwin-arm64", artifact: "mason4agents-darwin-arm64", os: "darwin", cpu: "arm64", executable: "mason4agents" },
  { name: "mason4agents-win32-x64", artifact: "mason4agents-win32-x64.exe", os: "win32", cpu: "x64", executable: "mason4agents.exe" },
  { name: "mason4agents-win32-arm64", artifact: "mason4agents-win32-arm64.exe", os: "win32", cpu: "arm64", executable: "mason4agents.exe" },
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "m4a-native-packages-"));
  roots.push(root);
  return root;
}

function writeRootPackage(root: string): void {
  mkdirSync(join(root, "dist", "bin"), { recursive: true });
  mkdirSync(join(root, "dist", "pi"), { recursive: true });
  writeFileSync(join(root, "dist", "bin", "mason4agents.js"), "#!/usr/bin/env bun\n");
  writeFileSync(join(root, "dist", "pi", "extension.js"), "export {};\n");
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  writeFileSync(join(root, "README.md"), "# mason4agents\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "mason4agents",
    version: "9.8.7",
    description: "fixture package",
    type: "module",
    license: "MIT",
    repository: { type: "git", url: "git+https://example.invalid/mason4agents.git" },
    bin: { mason4agents: "dist/bin/mason4agents.js" },
    keywords: ["pi-package"],
    omp: { extensions: ["dist/pi/extension.js"] },
    pi: { extensions: ["dist/pi/extension.js"] },
    dependencies: { "@sinclair/typebox": "^0.34.49" },
  }, null, 2));
}

function writeArtifacts(root: string): string {
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  for (const nativePackage of nativePackages) {
    const artifact = join(artifacts, nativePackage.artifact);
    writeFileSync(artifact, "#!/bin/sh\nexit 0\n");
    if (nativePackage.os !== "win32") chmodSync(artifact, 0o755);
  }
  return artifacts;
}

function publishTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GITHUB_REF;
  delete env.GITHUB_REF_NAME;
  delete env.GITHUB_REF_TYPE;
  return env;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeFakeNpm(root: string): { fakeBin: string; logPath: string } {
  const fakeBin = join(root, "bin");
  const logPath = join(root, "npm.log");
  mkdirSync(fakeBin, { recursive: true });
  const fakeNpm = join(fakeBin, "npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.M4A_NPM_LOG, \`\${process.cwd()}|\${args.join("\\u001f")}\\n\`);

if (args[0] === "view") {
  const spec = args[1];
  const existing = new Set((process.env.M4A_NPM_EXISTING ?? "").split(",").filter(Boolean));
  if (existing.has(spec)) {
    console.log(spec.slice(spec.lastIndexOf("@") + 1));
    process.exit(0);
  }
  console.error("npm error code E404");
  console.error(\`npm error 404 Not Found - GET https://registry.npmjs.org/\${spec}\`);
  process.exit(1);
}

if (args[0] === "pack") {
  const files = ["package.json", "LICENSE"];
  for (const path of ["README.md", "dist/bin/mason4agents.js", "dist/pi/extension.js", "bin/mason4agents", "bin/mason4agents.exe"]) {
    if (existsSync(join(process.cwd(), path))) files.push(path);
  }
  console.log(JSON.stringify([{ filename: "fixture.tgz", files: files.map((path) => ({ path })) }]));
  process.exit(0);
}

if (args[0] === "publish") process.exit(0);
process.exit(1);
`);
  chmodSync(fakeNpm, 0o755);
  return { fakeBin, logPath };
}

function loggedNpmArgs(logPath: string): string[][] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("|")[1]?.split("\u001f") ?? []);
}

describe("native npm package staging", () => {
  test("stages all native optional dependency packages before the root package", () => {
    const root = tempRoot();
    writeRootPackage(root);
    const artifacts = writeArtifacts(root);
    const outDir = join(root, "out");

    const result = spawnSync(process.execPath, [publishScript, "--pack", "--root", root, "--artifacts", artifacts, "--out-dir", outDir], {
      cwd: root,
      encoding: "utf8",
      env: publishTestEnv(),
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const rootManifest = readJson(join(outDir, "staging", "mason4agents", "package.json"));
    expect(rootManifest.optionalDependencies).toEqual(Object.fromEntries(nativePackages.map((nativePackage) => [nativePackage.name, "9.8.7"])));

    const linuxManifest = readJson(join(outDir, "staging", "mason4agents-linux-x64-gnu", "package.json"));
    expect(linuxManifest).toMatchObject({
      name: "mason4agents-linux-x64-gnu",
      version: "9.8.7",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    });
    expect(linuxManifest.bin).toBeUndefined();

    const windowsManifest = readJson(join(outDir, "staging", "mason4agents-win32-x64", "package.json"));
    expect(windowsManifest).toMatchObject({
      name: "mason4agents-win32-x64",
      os: ["win32"],
      cpu: ["x64"],
      files: ["bin/mason4agents.exe", "LICENSE", "package.json"],
    });
    expect(windowsManifest.libc).toBeUndefined();

    const tarballs = readdirSync(join(outDir, "tarballs"));
    expect(tarballs).toContain("mason4agents-9.8.7.tgz");
    expect(tarballs).toContain("mason4agents-linux-x64-gnu-9.8.7.tgz");
    expect(tarballs).toContain("mason4agents-win32-x64-9.8.7.tgz");
  }, 30_000);

  test("stages only Linux and macOS packages for non-windows publish", () => {
    const root = tempRoot();
    writeRootPackage(root);
    const artifacts = writeArtifacts(root);
    const outDir = join(root, "out");

    const result = spawnSync(process.execPath, [publishScript, "--pack", "--platform", "non-windows", "--root", root, "--artifacts", artifacts, "--out-dir", outDir], {
      cwd: root,
      encoding: "utf8",
      env: publishTestEnv(),
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const rootManifest = readJson(join(outDir, "staging", "mason4agents", "package.json"));
    expect(rootManifest.optionalDependencies).toEqual(Object.fromEntries(nativePackages.slice(0, 4).map((nativePackage) => [nativePackage.name, "9.8.7"])));

    const tarballs = readdirSync(join(outDir, "tarballs"));
    expect(tarballs).toContain("mason4agents-linux-x64-gnu-9.8.7.tgz");
    expect(tarballs).toContain("mason4agents-darwin-arm64-9.8.7.tgz");
    expect(tarballs).not.toContain("mason4agents-win32-x64-9.8.7.tgz");
    expect(tarballs).not.toContain("mason4agents-win32-arm64-9.8.7.tgz");
  }, 30_000);

  test("publishes provenance packages with public access for first publish", () => {
    const root = tempRoot();
    writeRootPackage(root);
    const artifacts = writeArtifacts(root);
    const outDir = join(root, "out");
    const { fakeBin, logPath } = writeFakeNpm(root);

    const result = spawnSync(process.execPath, [publishScript, "--dry-run", "--provenance", "--root", root, "--artifacts", artifacts, "--out-dir", outDir], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...publishTestEnv(),
        M4A_NPM_LOG: logPath,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const publishArgs = loggedNpmArgs(logPath).filter((args) => args[0] === "publish");
    expect(publishArgs).toHaveLength(7);
    for (const args of publishArgs) {
      expect(args).toContain("--provenance");
      expect(args).toContain("--access");
      expect(args).toContain("public");
    }
  }, 30_000);

  test("skips already published package versions when resuming publish", () => {
    const root = tempRoot();
    writeRootPackage(root);
    const artifacts = writeArtifacts(root);
    const outDir = join(root, "out");
    const { fakeBin, logPath } = writeFakeNpm(root);
    const existing = nativePackages.slice(0, 4).map((nativePackage) => `${nativePackage.name}@9.8.7`);

    const result = spawnSync(process.execPath, [publishScript, "--provenance", "--platform", "non-windows", "--root", root, "--artifacts", artifacts, "--out-dir", outDir], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...publishTestEnv(),
        M4A_NPM_EXISTING: existing.join(","),
        M4A_NPM_LOG: logPath,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const publishArgs = loggedNpmArgs(logPath).filter((args) => args[0] === "publish");
    expect(publishArgs.map((args) => args[1]?.split("/").at(-1))).toEqual(["mason4agents"]);
  }, 30_000);
});
