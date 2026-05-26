import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncMasonLspConfig } from "../../src/pi/lsp-config";
import { registerInstalledTools, renderRegisterResult } from "../../src/pi/register";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempEnv(): { root: string; env: NodeJS.ProcessEnv; binDir: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), "m4a-lsp-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    MASON4AGENTS_DATA_HOME: join(root, "data"),
    PATH: "/usr/bin",
  };
  const binDir = join(root, "data", "mason4agents", "bin");
  return { root, env, binDir, configPath: join(root, ".omp", "agent", "lsp.json") };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("Mason LSP config sync", () => {
  test("writes OMP user LSP config with absolute Mason commands", () => {
    const { env, binDir, configPath } = tempEnv();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "rust-analyzer"), "");

    const result = syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(result).toMatchObject({ configPath, servers: ["rust-analyzer"], changed: true });
    expect(json.mason4agents).toMatchObject({ generated: true, binDir, servers: ["rust-analyzer"] });
    expect(json.servers).toMatchObject({
      "rust-analyzer": { command: join(binDir, "rust-analyzer") },
    });
  });

  test("writes full config for fallback LSP packages outside OMP built-ins", () => {
    const { root, env, binDir, configPath } = tempEnv();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "vtsls"), "");

    const stateFile = join(root, ".local", "state", "mason4agents", "installed.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      packages: {
        vtsls: {
          name: "vtsls",
          version: "1.0.0",
          source_id: "pkg:npm/vtsls@1.0.0",
          bins: { vtsls: "bin/vtsls" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
      },
    }));

    const registryFile = join(root, ".cache", "mason4agents", "registry", "index.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      packages: {
        vtsls: {
          name: "vtsls",
          categories: ["LSP"],
          languages: ["TypeScript", "JavaScript"],
          neovim: { lspconfig: "vtsls" },
        },
      },
    }));

    const result = syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(result).toMatchObject({ configPath, servers: ["vtsls"], lspPackages: ["vtsls"], changed: true });
    expect(json.servers).toMatchObject({
      vtsls: {
        command: join(binDir, "vtsls"),
        args: ["--stdio"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
        rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
        initOptions: { hostInfo: "omp-coding-agent" },
      },
    });
  });

  test("uses OMP built-in defaults as the primary registration shape when available", () => {
    const { root, env, binDir, configPath } = tempEnv();
    const ompPackageDir = join(root, "omp", "packages", "coding-agent");
    env.MASON4AGENTS_OMP_PACKAGE_DIR = ompPackageDir;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "typescript-language-server"), "");

    const defaultsPath = join(ompPackageDir, "src", "lsp", "defaults.json");
    mkdirSync(dirname(defaultsPath), { recursive: true });
    writeFileSync(join(ompPackageDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
    writeFileSync(defaultsPath, JSON.stringify({
      "typescript-language-server": {
        command: "typescript-language-server",
        args: ["--stdio"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
        rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
      },
    }));

    const stateFile = join(root, ".local", "state", "mason4agents", "installed.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      packages: {
        "typescript-language-server": {
          name: "typescript-language-server",
          version: "1.0.0",
          source_id: "pkg:npm/typescript-language-server@1.0.0",
          bins: { "typescript-language-server": "bin/typescript-language-server" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
      },
    }));

    const registryFile = join(root, ".cache", "mason4agents", "registry", "index.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      packages: {
        "typescript-language-server": {
          name: "typescript-language-server",
          categories: ["LSP"],
          languages: ["TypeScript", "JavaScript"],
        },
      },
    }));

    syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(json.servers).toMatchObject({
      "typescript-language-server": { command: join(binDir, "typescript-language-server") },
    });
  });

  test("prefers OMP built-in server keys over registry lspconfig aliases", () => {
    const { root, env, binDir, configPath } = tempEnv();
    const ompPackageDir = join(root, "omp", "packages", "coding-agent");
    env.MASON4AGENTS_OMP_PACKAGE_DIR = ompPackageDir;
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "rust-analyzer"), "");
    writeFileSync(join(binDir, "typescript-language-server"), "");

    const defaultsPath = join(ompPackageDir, "src", "lsp", "defaults.json");
    mkdirSync(dirname(defaultsPath), { recursive: true });
    writeFileSync(join(ompPackageDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
    writeFileSync(defaultsPath, JSON.stringify({
      "rust-analyzer": { command: "rust-analyzer" },
      "typescript-language-server": { command: "typescript-language-server" },
    }));

    const stateFile = join(root, ".local", "state", "mason4agents", "installed.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      packages: {
        "rust-analyzer": {
          name: "rust-analyzer",
          version: "1.0.0",
          source_id: "pkg:generic/acme/rust-analyzer@1.0.0",
          bins: { "rust-analyzer": "bin/rust-analyzer" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
        "typescript-language-server": {
          name: "typescript-language-server",
          version: "1.0.0",
          source_id: "pkg:npm/typescript-language-server@1.0.0",
          bins: { "typescript-language-server": "bin/typescript-language-server" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
      },
    }));

    const registryFile = join(root, ".cache", "mason4agents", "registry", "index.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      packages: {
        "rust-analyzer": {
          name: "rust-analyzer",
          categories: ["LSP"],
          languages: ["Rust"],
          neovim: { lspconfig: "rust_analyzer" },
        },
        "typescript-language-server": {
          name: "typescript-language-server",
          categories: ["LSP"],
          languages: ["TypeScript", "JavaScript"],
          neovim: { lspconfig: "ts_ls" },
        },
      },
    }));

    const result = syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(result).toMatchObject({
      servers: ["rust-analyzer", "typescript-language-server"],
      lspPackages: ["rust-analyzer", "typescript-language-server"],
    });
    expect(json.servers).toMatchObject({
      "rust-analyzer": { command: join(binDir, "rust-analyzer") },
      "typescript-language-server": { command: join(binDir, "typescript-language-server") },
    });
    expect((json.servers as Record<string, unknown>).rust_analyzer).toBeUndefined();
    expect((json.servers as Record<string, unknown>).ts_ls).toBeUndefined();
  });

  test("syncs installed registry LSP packages beyond the static fallback list", () => {
    const { root, env, binDir, configPath } = tempEnv();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "toy-language-server"), "");
    writeFileSync(join(binDir, "toyfmt"), "");

    const stateFile = join(root, ".local", "state", "mason4agents", "installed.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      packages: {
        "toy-language-server": {
          name: "toy-language-server",
          version: "1.0.0",
          source_id: "pkg:generic/acme/toy-language-server@1.0.0",
          bins: { "toy-language-server": "bin/toy-language-server" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
        toyfmt: {
          name: "toyfmt",
          version: "1.0.0",
          source_id: "pkg:generic/acme/toyfmt@1.0.0",
          bins: { toyfmt: "bin/toyfmt" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
      },
    }));

    const registryFile = join(root, ".cache", "mason4agents", "registry", "index.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      packages: {
        "toy-language-server": {
          name: "toy-language-server",
          categories: ["LSP"],
          languages: ["TypeScript"],
          neovim: { lspconfig: "toy_ls" },
        },
        toyfmt: {
          name: "toyfmt",
          categories: ["Formatter"],
        },
      },
    }));

    const result = syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(result).toMatchObject({
      configPath,
      servers: ["toy_ls"],
      lspPackages: ["toy-language-server"],
      changed: true,
    });
    expect(json.servers).toMatchObject({
      toy_ls: { command: join(binDir, "toy-language-server") },
    });
    expect((json.servers as Record<string, unknown>).toyfmt).toBeUndefined();
  });

  test("register command helper updates OMP from installed LSP metadata", () => {
    const { root, env, binDir, configPath } = tempEnv();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "toy-language-server"), "");

    const stateFile = join(root, ".local", "state", "mason4agents", "installed.json");
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      packages: {
        "toy-language-server": {
          name: "toy-language-server",
          version: "1.0.0",
          source_id: "pkg:generic/acme/toy-language-server@1.0.0",
          bins: { "toy-language-server": "bin/toy-language-server" },
          share: {},
          opt: {},
          installed_at: "2026-01-01T00:00:00Z",
        },
      },
    }));

    const registryFile = join(root, ".cache", "mason4agents", "registry", "index.json");
    mkdirSync(dirname(registryFile), { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      packages: {
        "toy-language-server": {
          name: "toy-language-server",
          categories: ["LSP"],
          languages: ["TypeScript"],
          neovim: { lspconfig: "toy_ls" },
        },
      },
    }));

    const result = registerInstalledTools(["--omp"], env);
    const text = renderRegisterResult(result);

    expect(result.omp).toMatchObject({ configPath, servers: ["toy_ls"], lspPackages: ["toy-language-server"], changed: true });
    expect(text).toContain("OMP config");
    expect(text).toContain("toy_ls");
  });

  test("merges with existing server settings", () => {
    const { env, binDir, configPath } = tempEnv();
    mkdirSync(binDir, { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(join(binDir, "rust-analyzer"), "");
    writeFileSync(configPath, JSON.stringify({
      servers: {
        "rust-analyzer": { command: "rust-analyzer", args: ["--stdio"] },
        custom: { command: "custom-ls", fileTypes: [".custom"], rootMarkers: [".custom-root"] },
      },
    }));

    syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(json.servers).toMatchObject({
      "rust-analyzer": { command: join(binDir, "rust-analyzer"), args: ["--stdio"] },
      custom: { command: "custom-ls" },
    });
  });

  test("removes stale generated overrides after uninstall", () => {
    const { env, binDir, configPath } = tempEnv();
    const executable = join(binDir, "rust-analyzer");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(executable, "");
    syncMasonLspConfig(env);

    rmSync(executable);
    const result = syncMasonLspConfig(env);
    const json = readJson(configPath);

    expect(result).toMatchObject({ servers: [], changed: true });
    expect(json.mason4agents).toMatchObject({ generated: true, binDir, servers: [] });
    expect((json.servers as Record<string, unknown>)["rust-analyzer"]).toBeUndefined();
  });
});
