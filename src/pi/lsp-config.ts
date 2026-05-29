import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { masonBinDir, masonCacheDir, masonStateDir } from "./path-env";
import { ompBuiltInServerNames } from "./omp-lsp-defaults";

const CONFIG_FILE = "lsp.json";
const GENERATED_LSP_WARMUP_TIMEOUT_MS = 5000;

const MASON_LSP_COMMANDS: readonly [server: string, command: string][] = [
  ["rust-analyzer", "rust-analyzer"],
  ["tlaplus", "tlapm_lsp"],
  ["clangd", "clangd"],
  ["zls", "zls"],
  ["gopls", "gopls"],
  ["typescript-language-server", "typescript-language-server"],
  ["biome", "biome"],
  ["eslint", "vscode-eslint-language-server"],
  ["denols", "deno"],
  ["vscode-html-language-server", "vscode-html-language-server"],
  ["vscode-css-language-server", "vscode-css-language-server"],
  ["vscode-json-language-server", "vscode-json-language-server"],
  ["tailwindcss", "tailwindcss-language-server"],
  ["svelte", "svelteserver"],
  ["vue-language-server", "vue-language-server"],
  ["astro", "astro-ls"],
  ["pyright", "pyright-langserver"],
  ["basedpyright", "basedpyright-langserver"],
  ["pylsp", "pylsp"],
  ["ruff", "ruff"],
  ["jdtls", "jdtls"],
  ["kotlin-lsp", "kotlin-lsp"],
  ["metals", "metals"],
  ["hls", "haskell-language-server-wrapper"],
  ["ocamllsp", "ocamllsp"],
  ["elixirls", "elixir-ls"],
  ["erlangls", "erlang_ls"],
  ["gleam", "gleam"],
  ["solargraph", "solargraph"],
  ["ruby-lsp", "ruby-lsp"],
  ["rubocop", "rubocop"],
  ["bashls", "bash-language-server"],
  ["lua-language-server", "lua-language-server"],
  ["intelephense", "intelephense"],
  ["phpactor", "phpactor"],
  ["omnisharp", "omnisharp"],
  ["yamlls", "yaml-language-server"],
  ["terraformls", "terraform-ls"],
  ["dockerls", "docker-langserver"],
  ["helm-ls", "helm_ls"],
  ["nixd", "nixd"],
  ["nil", "nil"],
  ["ols", "ols"],
  ["dartls", "dart"],
  ["marksman", "marksman"],
  ["texlab", "texlab"],
  ["graphql", "graphql-lsp"],
  ["prismals", "prisma-language-server"],
  ["vimls", "vim-language-server"],
  ["emmet-language-server", "emmet-language-server"],
  ["sourcekit-lsp", "sourcekit-lsp"],
  ["swiftlint", "swiftlint"],
];

export interface MasonLspConfigSyncResult {
  configPath: string;
  servers: string[];
  changed: boolean;
  skipped?: string;
  lspPackages?: string[];
}

type OmpLspServerConfig = {
  command: string;
  args?: string[];
  fileTypes?: string[];
  rootMarkers?: string[];
  initOptions?: Record<string, unknown>;
  warmupTimeoutMs?: number;
};

type CustomLspTemplate = Omit<OmpLspServerConfig, "command"> & {
  bin?: string;
};

const VERIFIED_CUSTOM_LSP_TEMPLATES: Record<string, CustomLspTemplate> = {
  vtsls: {
    bin: "vtsls",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    initOptions: { hostInfo: "omp-coding-agent" },
  },
};

export function syncMasonLspConfig(env: NodeJS.ProcessEnv = process.env): MasonLspConfigSyncResult {
  const configPath = join(ompAgentDir(env), CONFIG_FILE);
  const binDir = masonBinDir(env);
  const overrides = masonLspOverrides(env, binDir);
  const servers = Object.keys(overrides.configs);
  const lspPackages = Object.keys(overrides.packages);
  const existing = readJsonObject(configPath);
  if (existing === null) {
    return { configPath, servers, lspPackages, changed: false, skipped: "invalid_json" };
  }
  if (servers.length === 0 && existing === undefined) return { configPath, servers, lspPackages, changed: false };

  const root = existing ?? {};
  const rawServers = isRecord(root.servers) ? root.servers : {};
  const nextServers: Record<string, unknown> = { ...rawServers };
  const previous = generatedMetadata(root.mason4agents);
  let changed = !isRecord(root.servers);

  for (const server of previous.servers) {
    if (server in overrides.configs) continue;
    const current = nextServers[server];
    if (isRecord(current) && isGeneratedCommand(current.command, previous.binDir ?? binDir, binDir)) {
      delete nextServers[server];
      changed = true;
    }
  }

  for (const [server, config] of Object.entries(overrides.configs)) {
    const current = nextServers[server];
    if (!isRecord(current)) {
      nextServers[server] = config;
      changed = true;
      continue;
    }
    const next = mergeServerConfig(current, config, binDir);
    if (shouldUpdateServerConfig(current, next, binDir)) {
      nextServers[server] = next;
      changed = true;
    }
  }

  const nextRoot = {
    ...root,
    mason4agents: {
      generated: true,
      binDir,
      servers,
      lspPackages,
    },
    servers: nextServers,
  };

  if (!changed && JSON.stringify(root.mason4agents) === JSON.stringify(nextRoot.mason4agents)) {
    return { configPath, servers, lspPackages, changed: false };
  }

  atomicWriteFileSync(configPath, `${JSON.stringify(nextRoot, null, 2)}\n`);
  return { configPath, servers, lspPackages, changed: true };
}

function masonLspOverrides(env: NodeJS.ProcessEnv, binDir: string): { configs: Record<string, OmpLspServerConfig>; packages: Record<string, string> } {
  const configs = staticMasonLspOverrides(binDir);
  const packages: Record<string, string> = {};
  const builtInServers = ompBuiltInServerNames(env);
  if (builtInServers.size === 0) {
    for (const [server] of MASON_LSP_COMMANDS) builtInServers.add(server);
  }
  for (const entry of dynamicMasonLspOverrides(env, binDir, builtInServers)) {
    configs[entry.server] = entry.config;
    packages[entry.package] = entry.server;
  }
  return { configs, packages };
}

function generatedLspServerConfig(command: string): OmpLspServerConfig {
  return { command, warmupTimeoutMs: GENERATED_LSP_WARMUP_TIMEOUT_MS };
}

function staticMasonLspOverrides(binDir: string): Record<string, OmpLspServerConfig> {
  const overrides: Record<string, OmpLspServerConfig> = {};
  for (const [server, command] of MASON_LSP_COMMANDS) {
    const executable = resolveBinExecutable(binDir, command);
    if (executable) overrides[server] = generatedLspServerConfig(executable);
  }
  return overrides;
}

function dynamicMasonLspOverrides(
  env: NodeJS.ProcessEnv,
  binDir: string,
  builtInServers: Set<string>,
): Array<{ package: string; server: string; config: OmpLspServerConfig }> {
  const installed = readInstalledPackages(env);
  const registry = readRegistryPackages(env);
  const result: Array<{ package: string; server: string; config: OmpLspServerConfig }> = [];
  for (const [name, installedPackage] of Object.entries(installed)) {
    const packageName = stringValue(installedPackage.name) || name;
    const spec = registry[packageName];
    if (!spec || !isLspPackage(spec)) continue;
    const server = preferredLspServerName(packageName, spec, builtInServers);
    const executable = resolveBinExecutable(
      binDir,
      preferredBinName(installedPackage, packageName, server, customLspBinName(packageName, spec)),
    );
    if (!executable) continue;
    const config = builtInServers.has(server)
      ? generatedLspServerConfig(executable)
      : lspServerConfig(packageName, spec, executable);
    if (!config) continue;
    result.push({ package: packageName, server, config });
  }
  result.sort((left, right) => left.server.localeCompare(right.server));
  return result;
}

function readInstalledPackages(env: NodeJS.ProcessEnv): Record<string, Record<string, unknown>> {
  const root = readJsonObject(join(masonStateDir(env), "installed.json"));
  const packages = root?.packages;
  if (!isRecord(packages)) return {};
  return recordEntries(packages);
}

function readRegistryPackages(env: NodeJS.ProcessEnv): Record<string, Record<string, unknown>> {
  const root = readJsonObject(join(masonCacheDir(env), "registry", "index.json"));
  const packages = root?.packages;
  if (!isRecord(packages)) return {};
  return recordEntries(packages);
}

function recordEntries(value: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child)) result[key] = child;
  }
  return result;
}

function isLspPackage(spec: Record<string, unknown>): boolean {
  if (stringValue(recordValue(spec.neovim)?.lspconfig).length > 0) return true;
  return stringValues(spec.categories).some((category) => category.toLocaleLowerCase() === "lsp");
}

function preferredLspServerName(
  packageName: string,
  spec: Record<string, unknown>,
  builtInServers: Set<string>,
): string {
  const lspconfig = stringValue(recordValue(spec.neovim)?.lspconfig);
  if (builtInServers.has(packageName)) return packageName;
  if (lspconfig.length > 0 && builtInServers.has(lspconfig)) return lspconfig;
  return lspconfig || packageName;
}

function preferredBinName(
  installedPackage: Record<string, unknown>,
  packageName: string,
  server: string,
  preferred?: string,
): string {
  const bins = Object.keys(recordValue(installedPackage.bins) ?? {}).sort((left, right) => left.localeCompare(right));
  return (preferred && bins.includes(preferred) ? preferred : undefined)
    ?? bins.find((bin) => bin === packageName)
    ?? bins.find((bin) => bin === server)
    ?? bins.find((bin) => bin.includes("language-server"))
    ?? bins[0]
    ?? preferred
    ?? packageName;
}

function lspServerConfig(packageName: string, spec: Record<string, unknown>, command: string): OmpLspServerConfig | undefined {
  const template = customLspTemplate(packageName, spec);
  if (!template) return undefined;
  const { bin: _bin, ...config } = template;
  return { command, warmupTimeoutMs: GENERATED_LSP_WARMUP_TIMEOUT_MS, ...config };
}

function customLspTemplate(packageName: string, spec: Record<string, unknown>): CustomLspTemplate | undefined {
  const server = stringValue(recordValue(spec.neovim)?.lspconfig);
  return (server ? VERIFIED_CUSTOM_LSP_TEMPLATES[server] : undefined) ?? VERIFIED_CUSTOM_LSP_TEMPLATES[packageName];
}

function customLspBinName(packageName: string, spec: Record<string, unknown>): string | undefined {
  return customLspTemplate(packageName, spec)?.bin;
}


function resolveBinExecutable(binDir: string, command: string): string | undefined {
  const direct = join(binDir, command);
  if (isFileLike(direct)) return direct;
  if (process.platform === "win32") {
    for (const extension of [".cmd", ".exe", ".bat"]) {
      const candidate = `${direct}${extension}`;
      if (isFileLike(candidate)) return candidate;
    }
  }
  return undefined;
}

function isFileLike(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function mergeServerConfig(current: Record<string, unknown>, config: OmpLspServerConfig, binDir: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, ...config };
  if (!shouldUpdateCommand(current.command, config.command, binDir)) {
    next.command = current.command;
  }
  if (
    typeof current.warmupTimeoutMs === "number"
    && current.warmupTimeoutMs > GENERATED_LSP_WARMUP_TIMEOUT_MS
  ) {
    next.warmupTimeoutMs = current.warmupTimeoutMs;
  }
  return next;
}

function shouldUpdateServerConfig(current: Record<string, unknown>, next: Record<string, unknown>, binDir: string): boolean {
  if (shouldUpdateCommand(current.command, stringValue(next.command), binDir)) return true;
  return JSON.stringify(current) !== JSON.stringify(next);
}

function shouldUpdateCommand(current: unknown, next: string, binDir: string): boolean {
  if (typeof current !== "string" || current.length === 0) return true;
  if (current === next) return false;
  if (pathIsWithin(resolve(current), binDir)) return true;
  return isBareCommand(current) && basename(current) === basename(next);
}

function isBareCommand(command: string): boolean {
  return !command.includes("/") && !command.includes("\\");
}

function isGeneratedCommand(current: unknown, previousBinDir: string, binDir: string): boolean {
  if (typeof current !== "string" || current.length === 0) return false;
  const resolved = resolve(current);
  return pathIsWithin(resolved, previousBinDir) || pathIsWithin(resolved, binDir);
}

function generatedMetadata(value: unknown): { binDir?: string; servers: string[] } {
  if (!isRecord(value) || value.generated !== true) return { servers: [] };
  const result: { binDir?: string; servers: string[] } = {
    servers: Array.isArray(value.servers) ? value.servers.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [],
  };
  if (typeof value.binDir === "string" && value.binDir.length > 0) {
    result.binDir = value.binDir;
  }
  return result;
}

export interface AtomicWriteFileSyncOps {
  tmpPath?: string;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  unlinkSync?: typeof unlinkSync;
}

export function atomicWriteFileSync(path: string, data: string, ops: AtomicWriteFileSyncOps = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = ops.tmpPath ?? join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    (ops.writeFileSync ?? writeFileSync)(tmpPath, data);
    (ops.renameSync ?? renameSync)(tmpPath, path);
  } catch (error) {
    try {
      (ops.unlinkSync ?? unlinkSync)(tmpPath);
    } catch {
      // Best-effort cleanup only; preserve the original write/rename failure.
    }
    throw error;
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined | null {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ompAgentDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.PI_CODING_AGENT_DIR;
  if (explicit && explicit.length > 0) return resolve(explicit);
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("HOME or USERPROFILE is required to resolve OMP agent directory");
  return join(home, env.PI_CONFIG_DIR ?? ".omp", "agent");
}

function pathIsWithin(candidate: string, base: string): boolean {
  const normalizedCandidate = pathUrl(candidate);
  const normalizedBase = pathUrl(resolve(base));
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}/`);
}

function pathUrl(path: string): string {
  return pathToFileURL(path).href.replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = stringValue(item);
    if (text.length > 0) result.push(text);
  }
  return result;
}
