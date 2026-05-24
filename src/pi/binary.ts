import { accessSync, constants, existsSync, statSync } from "node:fs";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BinaryResolution {
  path: string;
  source: "env" | "bundled" | "development";
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

  const root = packageRoot(startUrl);
  for (const candidate of bundledCandidates(root)) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      return { path: candidate, source: "bundled" };
    }
  }
  for (const candidate of developmentCandidates(root)) {
    if (existsSync(candidate) && isExecutable(candidate)) {
      return { path: candidate, source: "development" };
    }
  }
  throw new Error(`Unable to locate mason4agents native binary. Set MASON4AGENTS_BIN or build crates/mason4agents.`);
}

function isExecutable(filePath: string): boolean {
  if (process.platform === "win32") {
    return existsSync(filePath) && statSync(filePath).isFile();
  }
  try {
    return statSync(filePath).isFile() && (accessSync(filePath, constants.X_OK), true);
  } catch {
    return false;
  }
}


export function packageRoot(startUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
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
  return resolve(dirname(fileURLToPath(startUrl)), "..", "..");
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


function developmentCandidates(root: string): string[] {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    join(root, "target", "debug", "mason4agents" + exe),
    join(root, "target", "release", "mason4agents" + exe),
    join(root, "..", "target", "debug", "mason4agents" + exe),
    join(root, "..", "target", "release", "mason4agents" + exe)
  ];
}


function normalizeArch(arch: string): string {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return arch;
}
