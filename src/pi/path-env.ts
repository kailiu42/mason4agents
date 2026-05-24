import { mkdirSync } from "node:fs";
import { join, delimiter } from "node:path";

export interface PathInjectionResult {
  dataDir: string;
  binDir: string;
  changed: boolean;
  path: string;
}

export function masonDataDir(env: NodeJS.ProcessEnv = process.env): string {
  // On Windows, map LOCALAPPDATA to XDG_DATA_HOME if not set,
  // matching Rust MasonPaths::from_env behavior.
  const xdgDataHome = env.XDG_DATA_HOME ?? (env.LOCALAPPDATA ? env.LOCALAPPDATA : undefined);

  // 1. MASON4AGENTS_DATA_HOME (appended with /mason4agents) — but only if absolute.
  //    Relative paths fall back to the default (matching Rust env_or_xdg).
  if (env.MASON4AGENTS_DATA_HOME && env.MASON4AGENTS_DATA_HOME.length > 0) {
    const p = env.MASON4AGENTS_DATA_HOME;
    if (!p.startsWith(".") && (p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p))) {
      return join(p, "mason4agents");
    }
  }

  // 2. XDG_DATA_HOME (or LOCALAPPDATA on Windows) — same absolute check.
  if (xdgDataHome && xdgDataHome.length > 0) {
    if (!xdgDataHome.startsWith(".") && (xdgDataHome.startsWith("/") || /^[A-Za-z]:[/\\]/.test(xdgDataHome))) {
      return join(xdgDataHome, "mason4agents");
    }
  }

  // 3. Fall back to HOME / .local / share / mason4agents (or USERPROFILE on Windows)
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) {
    throw new Error("HOME or USERPROFILE is required to resolve mason4agents data directory");
  }
  return join(home, ".local", "share", "mason4agents");
}

export function masonBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(masonDataDir(env), "bin");
}

export function ensureMasonBinOnPath(env: NodeJS.ProcessEnv = process.env): PathInjectionResult {
  const dataDir = masonDataDir(env);
  const binDir = join(dataDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const current = env.PATH;
  if (current === undefined) {
    // PATH was never set — treat as empty and set it now
    env.PATH = binDir;
    return { dataDir, binDir, changed: true, path: binDir };
  }
  // Split preserves empty segments
  const parts = current === "" ? [""] : current.split(delimiter);
  const alreadyFirst = parts[0] === binDir;
  const nextParts = alreadyFirst ? parts : [binDir, ...parts.filter((part) => part !== binDir)];
  const next = nextParts.join(delimiter);
  if (!alreadyFirst) {
    env.PATH = next;
  }
  return { dataDir, binDir, changed: !alreadyFirst, path: env.PATH ?? next };
}
