import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { masonCacheDir } from "./path-env";

const OMP_LSP_CACHE_SCHEMA_VERSION = 3;
const OMP_LSP_CACHE_FILE = "omp-default-lsp.json";
const OMP_DEFAULTS_RELATIVE_PATH = "src/lsp/defaults.json";
const OMP_PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";

interface OmpDefaultServerConfig {
  command: string;
  args?: string[];
  fileTypes?: string[];
  rootMarkers?: string[];
  initOptions?: Record<string, unknown>;
}

interface OmpLspDefaultConfigFile {
  defaults: Record<string, OmpDefaultServerConfig>;
  defaultsPath: string;
  packageDir: string;
}

interface CuratedPackage {
  package: string;
  capability: string;
}

interface CuratedRule {
  signal: string;
  reason: string;
  packages: CuratedPackage[];
}

interface OmpLspSuggestionCache {
  schema_version: number;
  source: string;
  source_ref?: string;
  fetched_at: string;
  rules: CuratedRule[];
}

export interface OmpLspDefaultsSyncResult {
  cachePath: string;
  changed: boolean;
  sourcePath?: string;
  signals: string[];
  skipped?: "omp_defaults_missing" | "invalid_defaults";
}

const OMP_LSP_RULES: ReadonlyArray<{ signal: string; server: string; package: string }> = [
  { signal: "rust", server: "rust-analyzer", package: "rust-analyzer" },
  { signal: "go", server: "gopls", package: "gopls" },
  { signal: "python", server: "pyright", package: "pyright" },
  { signal: "java", server: "jdtls", package: "jdtls" },
  { signal: "typescript", server: "typescript-language-server", package: "typescript-language-server" },
  { signal: "lua", server: "lua-language-server", package: "lua-language-server" },
  { signal: "shell", server: "bashls", package: "bash-language-server" },
  { signal: "docker", server: "dockerls", package: "dockerfile-language-server" },
  { signal: "terraform", server: "terraformls", package: "terraform-ls" },
  { signal: "yaml", server: "yamlls", package: "yaml-language-server" },
  { signal: "markdown", server: "marksman", package: "marksman" },
];

export function syncOmpLspDefaultsCache(env: NodeJS.ProcessEnv = process.env): OmpLspDefaultsSyncResult {
  const cachePath = ompLspDefaultsCachePath(env);
  const loaded = loadOmpLspDefaults(env);
  if (!loaded) {
    return { cachePath, changed: false, signals: [], skipped: "omp_defaults_missing" };
  }

  const cache = buildSuggestionCache(loaded.defaults, loaded.defaultsPath);
  const previous = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : undefined;
  if (previous !== undefined && hasSameStableCacheContent(previous, cache)) {
    return {
      cachePath,
      changed: false,
      sourcePath: loaded.defaultsPath,
      signals: cache.rules.map((rule) => rule.signal),
    };
  }

  const bytes = `${JSON.stringify(cache, null, 2)}\n`;
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, bytes);
  return {
    cachePath,
    changed: true,
    sourcePath: loaded.defaultsPath,
    signals: cache.rules.map((rule) => rule.signal),
  };
}

export function loadOmpLspDefaults(env: NodeJS.ProcessEnv = process.env): OmpLspDefaultConfigFile | undefined {
  const packageDir = resolveOmpPackageDir(env);
  if (!packageDir) return undefined;
  const defaultsPath = join(packageDir, OMP_DEFAULTS_RELATIVE_PATH);
  if (!existsSync(defaultsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(defaultsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    const defaults: Record<string, OmpDefaultServerConfig> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.command !== "string" || value.command.length === 0) continue;
      const args = stringArray(value.args);
      const fileTypes = stringArray(value.fileTypes);
      const rootMarkers = stringArray(value.rootMarkers);
      const initOptions = isRecord(value.initOptions) ? value.initOptions : undefined;
      defaults[name] = {
        command: value.command,
        ...(args ? { args } : {}),
        ...(fileTypes ? { fileTypes } : {}),
        ...(rootMarkers ? { rootMarkers } : {}),
        ...(initOptions ? { initOptions } : {}),
      };
    }
    return { defaults, defaultsPath, packageDir };
  } catch {
    return undefined;
  }
}

export function ompBuiltInServerNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(Object.keys(loadOmpLspDefaults(env)?.defaults ?? {}));
}

export function ompLspDefaultsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(masonCacheDir(env), "suggestions", OMP_LSP_CACHE_FILE);
}

function buildSuggestionCache(defaults: Record<string, OmpDefaultServerConfig>, sourcePath: string): OmpLspSuggestionCache {
  const rules: CuratedRule[] = [];
  for (const entry of OMP_LSP_RULES) {
    if (!(entry.server in defaults)) continue;
    rules.push({
      signal: entry.signal,
      reason: `OMP built-in defaults (${entry.server})`,
      packages: [{ package: entry.package, capability: "LSP" }],
    });
  }
  return {
    schema_version: OMP_LSP_CACHE_SCHEMA_VERSION,
    source: "omp-default-lsp",
    source_ref: sourcePath,
    fetched_at: new Date().toISOString(),
    rules,
  };
}

function hasSameStableCacheContent(previous: string, next: OmpLspSuggestionCache): boolean {
  try {
    const parsed = JSON.parse(previous) as unknown;
    return (
      isRecord(parsed) &&
      parsed.schema_version === next.schema_version &&
      parsed.source === next.source &&
      parsed.source_ref === next.source_ref &&
      hasSameRules(parsed.rules, next.rules)
    );
  } catch {
    return false;
  }
}

function hasSameRules(previous: unknown, next: CuratedRule[]): boolean {
  if (!Array.isArray(previous) || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const previousRule = previous[index];
    const nextRule = next[index];
    if (
      nextRule === undefined ||
      !isRecord(previousRule) ||
      previousRule.signal !== nextRule.signal ||
      previousRule.reason !== nextRule.reason ||
      !hasSamePackages(previousRule.packages, nextRule.packages)
    ) {
      return false;
    }
  }
  return true;
}

function hasSamePackages(previous: unknown, next: CuratedPackage[]): boolean {
  if (!Array.isArray(previous) || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const previousPackage = previous[index];
    const nextPackage = next[index];
    if (
      nextPackage === undefined ||
      !isRecord(previousPackage) ||
      previousPackage.package !== nextPackage.package ||
      previousPackage.capability !== nextPackage.capability
    ) {
      return false;
    }
  }
  return true;
}

function resolveOmpPackageDir(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = absoluteEnvPath(env.MASON4AGENTS_OMP_PACKAGE_DIR) ?? absoluteEnvPath(env.PI_PACKAGE_DIR);
  if (explicit && hasOmpPackageJson(explicit)) return explicit;

  for (const candidate of [process.argv[1], process.argv[0], process.cwd()]) {
    const resolved = walkToPackageDir(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function walkToPackageDir(start: string | undefined): string | undefined {
  if (!start || start.length === 0) return undefined;
  let current = resolve(start);
  if (!existsSync(current)) return undefined;
  if (!hasOmpPackageJson(current)) current = dirname(current);
  while (current !== dirname(current)) {
    if (hasOmpPackageJson(current)) return current;
    current = dirname(current);
  }
  return hasOmpPackageJson(current) ? current : undefined;
}

function hasOmpPackageJson(dir: string): boolean {
  const packageJson = join(dir, "package.json");
  if (!existsSync(packageJson)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    return parsed.name === OMP_PACKAGE_NAME;
  } catch {
    return false;
  }
}

function absoluteEnvPath(path: string | undefined): string | undefined {
  if (!path || path.startsWith(".")) return undefined;
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path) ? path : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
