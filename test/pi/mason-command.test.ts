import { describe, expect, test } from "bun:test";
import type { CliBridge } from "../../src/pi/cli";
import { executeMasonCommand, parseMasonCommandInput, tokenizeMasonArgs } from "../../src/pi/mason-command";
import { renderDisplayText } from "../../src/pi/mason-render";

function fakeBridge(result: unknown = []) {
  const calls: string[][] = [];
  const bridge: CliBridge = {
    async run(args: string[]) {
      calls.push(args);
      return result;
    },
  };
  return { bridge, calls };
}

describe("Mason command parser", () => {
  test("tokenizes shell-like arguments conservatively", () => {
    expect(tokenizeMasonArgs('search "lua formatter" --language Lua')).toEqual(["search", "lua formatter", "--language", "Lua"]);
    expect(tokenizeMasonArgs("install stylua\\ nightly 'lua language server'")).toEqual(["install", "stylua nightly", "lua language server"]);
    expect(() => tokenizeMasonArgs("search 'lua")).toThrow("Unterminated quoted string");
  });

  test("maps subcommands and aliases to CLI argv", () => {
    expect(parseMasonCommandInput("search stylua --language Lua --category Formatter --registry file:///tmp/reg")).toMatchObject({
      kind: "command",
      argv: ["search", "stylua", "--category", "Formatter", "--language", "Lua", "--registry", "file:///tmp/reg"],
      resultKind: "packages",
    });
    expect(parseMasonCommandInput("installed")).toMatchObject({ argv: ["list", "--installed"], resultKind: "installed" });
    expect(parseMasonCommandInput("outdated --registry=file:///tmp/reg")).toMatchObject({ argv: ["list", "--outdated", "--registry", "file:///tmp/reg"] });
    expect(parseMasonCommandInput("env --shell bash")).toMatchObject({ argv: ["env", "--shell", "bash"], resultKind: "env" });
    expect(parseMasonCommandInput("register --omp")).toMatchObject({ kind: "register", argv: ["--omp"], title: "mason register --omp" });
  });

  test("reports invalid input as human-readable display", async () => {
    const { bridge, calls } = fakeBridge();
    const model = await executeMasonCommand("install", bridge);
    const text = renderDisplayText(model);
    expect(text).toContain("install requires at least one package");
    expect(text).toContain("/mason install");
    expect(calls).toEqual([]);
  });

  test("executes and renders command results without raw JSON", async () => {
    const { bridge, calls } = fakeBridge([
      {
        name: "stylua",
        version: "v2.0.0",
        installed: false,
        installed_version: null,
        outdated: false,
        deprecated: false,
        languages: ["Lua"],
        categories: ["Formatter"],
        description: "Lua formatter",
      },
    ]);
    const model = await executeMasonCommand("search stylua --language Lua", bridge);
    const text = renderDisplayText(model);
    expect(calls).toEqual([["search", "stylua", "--language", "Lua"]]);
    expect(text).toContain("Name");
    expect(text).toContain("stylua");
    expect(text).toContain("available");
    expect(text).not.toContain("{\n");
  });
});
