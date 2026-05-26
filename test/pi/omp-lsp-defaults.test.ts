import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ompBuiltInServerNames, ompLspDefaultsCachePath, syncOmpLspDefaultsCache } from "../../src/pi/omp-lsp-defaults";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempEnv(): { root: string; env: NodeJS.ProcessEnv; ompPackageDir: string } {
  const root = mkdtempSync(join(tmpdir(), "m4a-omp-defaults-"));
  roots.push(root);
  const ompPackageDir = join(root, "omp", "packages", "coding-agent");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    MASON4AGENTS_CACHE_HOME: join(root, "cache-home"),
    MASON4AGENTS_OMP_PACKAGE_DIR: ompPackageDir,
  };
  return { root, env, ompPackageDir };
}

describe("OMP default LSP cache sync", () => {
  test("writes normalized suggestion cache from OMP defaults.json", () => {
    const { env, ompPackageDir } = tempEnv();
    const defaultsPath = join(ompPackageDir, "src", "lsp", "defaults.json");
    mkdirSync(dirname(defaultsPath), { recursive: true });
    writeFileSync(join(ompPackageDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
    writeFileSync(defaultsPath, JSON.stringify({
      "rust-analyzer": { command: "rust-analyzer" },
      "typescript-language-server": { command: "typescript-language-server" },
      pyright: { command: "pyright-langserver" },
      marksman: { command: "marksman" },
    }));

    const result = syncOmpLspDefaultsCache(env);
    const cachePath = ompLspDefaultsCachePath(env);
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      source: string;
      source_ref: string;
      rules: Array<{ signal: string; packages: Array<{ package: string }> }>;
    };

    expect(result).toMatchObject({
      cachePath,
      changed: true,
      sourcePath: defaultsPath,
      signals: ["rust", "python", "typescript", "markdown"],
    });
    expect(cache.source).toBe("omp-default-lsp");
    expect(cache.source_ref).toBe(defaultsPath);
    expect(cache.rules.map((rule) => ({
      signal: rule.signal,
      packages: rule.packages.map((entry) => entry.package),
    }))).toEqual([
      { signal: "rust", packages: ["rust-analyzer"] },
      { signal: "python", packages: ["pyright"] },
      { signal: "typescript", packages: ["typescript-language-server"] },
      { signal: "markdown", packages: ["marksman"] },
    ]);
  });

  test("returns built-in server names from detected OMP package", () => {
    const { env, ompPackageDir } = tempEnv();
    const defaultsPath = join(ompPackageDir, "src", "lsp", "defaults.json");
    mkdirSync(dirname(defaultsPath), { recursive: true });
    writeFileSync(join(ompPackageDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
    writeFileSync(defaultsPath, JSON.stringify({
      "typescript-language-server": { command: "typescript-language-server" },
      gopls: { command: "gopls" },
    }));

    expect([...ompBuiltInServerNames(env)].sort()).toEqual(["gopls", "typescript-language-server"]);
  });
});
