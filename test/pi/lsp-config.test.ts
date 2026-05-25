import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncMasonLspConfig } from "../../src/pi/lsp-config";

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
