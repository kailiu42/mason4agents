import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { nativePackageForRuntime, resolveMasonBinaryDetailed } from "../../src/pi/binary";
import { ensureMasonBinOnPath, masonDataDir } from "../../src/pi/path-env";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "m4a-ts-"));
  roots.push(root);
  return root;
}

function touchExecutable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

describe("binary resolver", () => {
  test("prefers MASON4AGENTS_BIN", () => {
    const root = tempRoot();
    const bin = join(root, "explicit");
    touchExecutable(bin);
    const resolved = resolveMasonBinaryDetailed({ MASON4AGENTS_BIN: bin });
    expect(resolved).toEqual({ path: bin, source: "env" });
  });

  test("uses bundled binary before development fallback", () => {
    const root = tempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    const bundled = join(root, "native", process.platform === "win32" ? "mason4agents.exe" : "mason4agents");
    touchExecutable(bundled);
    const start = pathToFileURL(join(root, "dist", "pi", "extension.js")).href;
    const resolved = resolveMasonBinaryDetailed({}, start);
    expect(resolved.source).toBe("bundled");
    expect(resolved.path).toBe(bundled);
  });

  test("searches ancestor directories when a nearer package.json is unrelated", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "cache", "package.json"), "{}");
    const bundled = join(root, "native", process.platform === "win32" ? `mason4agents-${process.platform}-${process.arch}.exe` : `mason4agents-${process.platform}-${process.arch}`);
    touchExecutable(bundled);
    const start = pathToFileURL(join(root, "cache", "dist", "pi", "extension.js")).href;
    const resolved = resolveMasonBinaryDetailed({}, start);
    expect(resolved).toEqual({ path: bundled, source: "bundled" });
  });

  test("repairs non-executable bundled binaries", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    const bundled = join(root, "native", `mason4agents-${process.platform}-${process.arch}`);
    mkdirSync(join(root, "native"), { recursive: true });
    writeFileSync(bundled, "#!/bin/sh\nexit 0\n");
    chmodSync(bundled, 0o644);
    const start = pathToFileURL(join(root, "dist", "pi", "extension.js")).href;
    const resolved = resolveMasonBinaryDetailed({}, start);
    expect(resolved).toEqual({ path: bundled, source: "bundled" });
    expect(statSync(bundled).mode & 0o111).not.toBe(0);
  });

  test("uses native optional dependency before development fallback", () => {
    const nativePackage = nativePackageForRuntime();
    if (!nativePackage) throw new Error(`Unsupported test platform: ${process.platform}/${process.arch}`);

    const root = tempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    const nativeBin = join(root, "node_modules", nativePackage.name, "bin", nativePackage.executable);
    const dev = join(root, "target", "debug", process.platform === "win32" ? "mason4agents.exe" : "mason4agents");
    touchExecutable(nativeBin);
    touchExecutable(dev);

    const start = pathToFileURL(join(root, "dist", "pi", "extension.js")).href;
    const resolved = resolveMasonBinaryDetailed({}, start);
    expect(resolved).toEqual({ path: nativeBin, source: "native-package" });
  });

  test("maps native optional dependency names for supported release platforms", () => {
    expect(nativePackageForRuntime("linux", "x64")).toEqual({ name: "mason4agents-linux-x64-gnu", executable: "mason4agents" });
    expect(nativePackageForRuntime("linux", "arm64")).toEqual({ name: "mason4agents-linux-arm64-gnu", executable: "mason4agents" });
    expect(nativePackageForRuntime("darwin", "arm64")).toEqual({ name: "mason4agents-darwin-arm64", executable: "mason4agents" });
    expect(nativePackageForRuntime("win32", "x64")).toEqual({ name: "mason4agents-win32-x64", executable: "mason4agents.exe" });
  });

  test("falls back to cargo target in development", () => {
    const root = tempRoot();
    writeFileSync(join(root, "package.json"), "{}");
    const dev = join(root, "target", "debug", process.platform === "win32" ? "mason4agents.exe" : "mason4agents");
    touchExecutable(dev);
    const start = pathToFileURL(join(root, "src", "pi", "extension.ts")).href;
    const resolved = resolveMasonBinaryDetailed({}, start);
    expect(resolved.source).toBe("development");
    expect(resolved.path).toBe(dev);
  });
});

describe("PATH injection", () => {
  test("resolves XDG data dir and prepends bin idempotently", () => {
    const root = tempRoot();
    const env: NodeJS.ProcessEnv = { HOME: join(root, "home"), XDG_DATA_HOME: join(root, "xdg-data"), PATH: "/usr/bin" };
    expect(masonDataDir(env)).toBe(join(root, "xdg-data", "mason4agents"));
    const first = ensureMasonBinOnPath(env);
    const second = ensureMasonBinOnPath(env);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect((env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")[0]).toBe(first.binDir);
  });

  test("explicit MASON4AGENTS_DATA_HOME overrides XDG", () => {
    const root = tempRoot();
    const env: NodeJS.ProcessEnv = { HOME: root, XDG_DATA_HOME: join(root, "xdg"), MASON4AGENTS_DATA_HOME: join(root, "override"), PATH: "" };
    const info = ensureMasonBinOnPath(env);
    expect(info.binDir).toBe(join(root, "override", "mason4agents", "bin"));
  });
});
