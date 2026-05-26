import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BinaryResolution {
  path: string;
  source: "env" | "bundled" | "native-package" | "development";
}

export interface NativePackageResolution {
  name: string;
  executable: string;
}

export function resolveMasonBinary(env: NodeJS.ProcessEnv = process.env, startUrl: string = import.meta.url): string {
  return resolveMasonBinaryDetailed(env, startUrl).path;
}

export function resolveMasonBinaryDetailed(env: NodeJS.ProcessEnv = process.env, startUrl: string = import.meta.url): BinaryResolution {
  if (env.MASON4AGENTS_BIN && env.MASON4AGENTS_BIN.length > 0) {
    const explicit = resolve(env.MASON4AGENTS_BIN);
    if (!existsSync(explicit)) {
      throw new Error(`MASON4AGENTS_BIN points to a missing file: ${explicit}`);
    }
    const stat = statSync(explicit);
    if (!stat.isFile()) {
      throw new Error(`MASON4AGENTS_BIN points to a non-file path: ${explicit}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
      throw new Error(`MASON4AGENTS_BIN points to a non-executable file: ${explicit}`);
    }
    return { path: explicit, source: "env" };
  }

  const roots = binarySearchRoots(startUrl);
  const checked: string[] = [];
  for (const root of roots) {
    for (const candidate of bundledCandidates(root)) {
      checked.push(candidate);
      if (existsSync(candidate) && isExecutable(candidate, true)) {
        return { path: candidate, source: "bundled" };
      }
    }
  }

  const nativePackage = nativePackageForRuntime();
  if (nativePackage) {
    for (const candidate of nativePackageCandidates(roots, nativePackage)) {
      checked.push(candidate);
      if (existsSync(candidate) && isExecutable(candidate, true)) {
        return { path: candidate, source: "native-package" };
      }
    }
  }

  for (const root of roots) {
    for (const candidate of developmentCandidates(root)) {
      checked.push(candidate);
      if (existsSync(candidate) && isExecutable(candidate, true)) {
        return { path: candidate, source: "development" };
      }
    }
  }
  throw new Error(
    `Unable to locate mason4agents native binary. Reinstall the plugin, set MASON4AGENTS_BIN to the Rust binary, or build crates/mason4agents. Checked ${checked.length} locations:\n${checked.map((candidate) => `  - ${candidate}`).join("\n")}\nSearch roots: ${roots.join(", ")}`,
  );
}

export function nativePackageForRuntime(platform: NodeJS.Platform = process.platform, arch: string = process.arch): NativePackageResolution | undefined {
  const normalizedArch = normalizeArch(arch);
  const executable = platform === "win32" ? "mason4agents.exe" : "mason4agents";
  if (platform === "linux") {
    if (normalizedArch === "x64" || normalizedArch === "arm64") {
      return { name: `mason4agents-linux-${normalizedArch}-gnu`, executable };
    }
    return undefined;
  }
  if (platform === "darwin" || platform === "win32") {
    if (normalizedArch === "x64" || normalizedArch === "arm64") {
      return { name: `mason4agents-${platform}-${normalizedArch}`, executable };
    }
  }
  return undefined;
}

function isExecutable(filePath: string, repairMode = false): boolean {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    if (!repairMode) return false;
  }
  try {
    chmodSync(filePath, stat.mode | 0o111);
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binarySearchRoots(startUrl: string): string[] {
  const roots: string[] = [];
  pushUnique(roots, packageRoot(startUrl));
  for (const dir of ancestorDirs(startUrl)) pushUnique(roots, dir);
  const selfRoot = packageRootFromPackageReference("mason4agents");
  if (selfRoot) pushUnique(roots, selfRoot);
  return roots;
}

function ancestorDirs(startUrl: string): string[] {
  const startDir = dirnameFromFileUrl(startUrl);
  if (!startDir) return [resolve(process.cwd())];
  const dirs: string[] = [];
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function packageRootFromPackageReference(packageName: string): string | undefined {
  const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolver !== "function") return undefined;
  try {
    return dirname(fileURLToPath(resolver(`${packageName}/package.json`)));
  } catch {
    return undefined;
  }
}

function dirnameFromFileUrl(url: string): string | undefined {
  try {
    return dirname(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

export function packageRoot(startUrl: string = import.meta.url): string {
  const startDir = dirnameFromFileUrl(startUrl);
  let dir = startDir ?? resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return startDir ? resolve(startDir, "..", "..") : resolve(process.cwd());
}

function bundledCandidates(root: string): string[] {
  const platform = process.platform;
  const arch = normalizeArch(process.arch);
  const exe = platform === "win32" ? ".exe" : "";
  const candidates: string[] = [
    join(root, "native", `mason4agents-${platform}-${arch}${exe}`),
    join(root, "native", `mason4agents${exe}`),
    join(root, "dist", "native", `mason4agents-${platform}-${arch}${exe}`),
    join(root, "dist", "native", `mason4agents${exe}`),
  ];
  // Build script generates mason4agents-win32-x64.exe, but some
  // package managers may bundle it without the .exe suffix.
  if (platform === "win32") {
    candidates.unshift(
      join(root, "native", `mason4agents-${platform}-${arch}`),
      join(root, "dist", "native", `mason4agents-${platform}-${arch}`),
    );
  }
  return candidates;
}

function nativePackageCandidates(roots: readonly string[], nativePackage: NativePackageResolution): string[] {
  const candidates: string[] = [];
  const resolvedPackageRoot = packageRootFromPackageReference(nativePackage.name);
  if (resolvedPackageRoot) pushUnique(candidates, join(resolvedPackageRoot, "bin", nativePackage.executable));
  for (const root of roots) {
    pushUnique(candidates, join(root, "node_modules", nativePackage.name, "bin", nativePackage.executable));
    pushUnique(candidates, join(dirname(root), nativePackage.name, "bin", nativePackage.executable));
  }
  return candidates;
}

function developmentCandidates(root: string): string[] {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    join(root, "target", "debug", "mason4agents" + exe),
    join(root, "target", "release", "mason4agents" + exe),
    join(root, "..", "target", "debug", "mason4agents" + exe),
    join(root, "..", "target", "release", "mason4agents" + exe),
  ];
}

function normalizeArch(arch: string): string {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return arch;
}
