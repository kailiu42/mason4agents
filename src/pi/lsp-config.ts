import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { masonBinDir } from "./path-env";

const CONFIG_FILE = "lsp.json";

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
}

export function syncMasonLspConfig(env: NodeJS.ProcessEnv = process.env): MasonLspConfigSyncResult {
  const configPath = join(ompAgentDir(env), CONFIG_FILE);
  const binDir = masonBinDir(env);
  const overrides = masonLspOverrides(binDir);
  const servers = Object.keys(overrides);
  const existing = readJsonObject(configPath);
  if (existing === null) {
    return { configPath, servers, changed: false, skipped: "invalid_json" };
  }
  if (servers.length === 0 && existing === undefined) return { configPath, servers, changed: false };

  const root = existing ?? {};
  const rawServers = isRecord(root.servers) ? root.servers : {};
  const nextServers: Record<string, unknown> = { ...rawServers };
  const previous = generatedMetadata(root.mason4agents);
  let changed = !isRecord(root.servers);

  for (const server of previous.servers) {
    if (server in overrides) continue;
    const current = nextServers[server];
    if (isRecord(current) && isGeneratedCommand(current.command, previous.binDir ?? binDir, binDir)) {
      delete nextServers[server];
      changed = true;
    }
  }

  for (const [server, command] of Object.entries(overrides)) {
    const current = nextServers[server];
    if (!isRecord(current)) {
      nextServers[server] = { command };
      changed = true;
      continue;
    }
    if (shouldUpdateCommand(current.command, command, binDir)) {
      nextServers[server] = { ...current, command };
      changed = true;
    }
  }

  const nextRoot = {
    ...root,
    mason4agents: {
      generated: true,
      binDir,
      servers,
    },
    servers: nextServers,
  };

  if (!changed && JSON.stringify(root.mason4agents) === JSON.stringify(nextRoot.mason4agents)) {
    return { configPath, servers, changed: false };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextRoot, null, 2)}\n`);
  return { configPath, servers, changed: true };
}

function masonLspOverrides(binDir: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [server, command] of MASON_LSP_COMMANDS) {
    const executable = resolveBinExecutable(binDir, command);
    if (executable) overrides[server] = executable;
  }
  return overrides;
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

function shouldUpdateCommand(current: unknown, next: string, binDir: string): boolean {
  if (typeof current !== "string" || current.length === 0) return true;
  if (current === next) return false;
  if (basename(current) === basename(next)) return true;
  return pathIsWithin(resolve(current), binDir);
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
