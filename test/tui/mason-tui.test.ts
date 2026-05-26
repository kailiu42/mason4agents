import { describe, expect, test } from "bun:test";
import { modelForResult, renderDisplay } from "../../src/tui/mason-render";
import { createMasonTui, MASON_TUI_COMMANDS, type MasonTuiHost } from "../../src/tui/mason-tui";

function packages() {
  return [
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
    {
      name: "lua-language-server",
      version: "v3.9.0",
      installed: true,
      installed_version: "v3.8.0",
      outdated: true,
      deprecated: false,
      languages: ["Lua"],
      categories: ["LSP"],
      description: "Lua LSP",
      neovim_lspconfig: "lua_ls",
    },
  ];
}

function suggestions() {
  return packages().map((pkg) => ({
    ...pkg,
    reason: pkg.name === "stylua" ? "Lua source files detected; Formatter via LazyVim" : "Lua source files detected; LSP via LazyVim",
    source: "lazyvim-extras-lang:builtin",
  }));
}

function host() {
  const calls: string[][] = [];
  let syncs = 0;
  const fake: MasonTuiHost = {
    async runCli(args: string[]) {
      calls.push(args);
      if (args[0] === "search") return packages();
      if (args[0] === "suggested") return suggestions();
      if (args[0] === "list" && args.includes("--installed")) {
        return [
          {
            name: "lua-language-server",
            version: "v3.8.0",
            bins: { "lua-language-server": "bin/lua-language-server" },
            installed_at: "2026-05-24T00:00:00Z",
          },
        ];
      }
      if (args[0] === "list") return packages();
      return { args };
    },
    syncAfterPackageChange() {
      syncs += 1;
    },
  };
  return { host: fake, calls, syncs: () => syncs };
}

describe("Mason TUI core", () => {
  test("renders selected table rows within changing widths", async () => {
    const { host: fake } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();

    const narrow = tui.renderLines(32);
    const wide = tui.renderLines(96);

    expect(narrow.every((line) => line.length <= 32)).toBe(true);
    expect(wide.every((line) => line.length <= 96)).toBe(true);
    expect(narrow.join("\n")).toContain("▶ stylua");
    expect(wide.join("\n")).toContain("Description");
    expect(wide.join("\n")).toContain("2 packages");
    expect(wide.join("\n")).not.toContain("mason list —");
  });

  test("uses available table width and wraps long cells inside their columns", () => {
    const model = modelForResult("packages", [
      {
        name: "asmfmt",
        version: "v1.3.2",
        installed: false,
        installed_version: null,
        outdated: false,
        deprecated: false,
        languages: ["Assembly"],
        categories: ["Formatter"],
        description: "Assembly formatter with a deliberately long description that should wrap inside the description column without shifting back to the package name column.",
      },
    ], "mason list");

    const lines = renderDisplay(model, { width: 96, maxRows: 8, selectedRow: 0, fixedHeight: true });
    const separator = lines.find((line) => /^  ─+$/.test(line));
    const firstRow = lines.find((line) => line.startsWith("▶ asmfmt"));
    const continuation = lines.find((line) => line.includes("description column without"));

    expect(lines.every((line) => line.length <= 96)).toBe(true);
    expect(separator?.length).toBe(96);
    expect(firstRow).toBeDefined();
    expect(continuation).toBeDefined();
    expect(continuation!.indexOf("description column without")).toBe(firstRow!.indexOf("Assembly formatter"));
    expect(continuation!.indexOf("description column without")).toBeGreaterThan(2);
  });

  test("keeps column widths stable while scrolling through different rows", () => {
    const model = modelForResult("packages", [
      {
        name: "a",
        version: "1",
        installed: false,
        installed_version: null,
        outdated: false,
        deprecated: false,
        languages: ["Lua"],
        categories: ["Formatter"],
        description: "short",
      },
      {
        name: "very-long-package-name",
        version: "2026.05.25",
        installed: true,
        installed_version: "2026.05.20",
        outdated: true,
        deprecated: false,
        languages: ["TypeScript", "JavaScript"],
        categories: ["LSP", "Formatter"],
        description: "longer description used to force a different visible row width",
      },
    ], "mason list");

    const firstPage = renderDisplay(model, { width: 96, maxRows: 1, scroll: 0, fixedHeight: true });
    const secondPage = renderDisplay(model, { width: 96, maxRows: 1, scroll: 1, fixedHeight: true });

    expect(firstPage[1]).toBe(secondPage[1]);
    expect(firstPage[2]).toBe(secondPage[2]);
  });

  test("keeps table height stable and pads unused body space", () => {
    const model = modelForResult("packages", [
      {
        name: "asmfmt",
        version: "v1.3.2",
        installed: false,
        installed_version: null,
        outdated: false,
        deprecated: false,
        languages: ["Assembly"],
        categories: ["Formatter"],
        description: "Assembly formatter with a deliberately long description that wraps over several display lines.",
      },
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
    ], "mason list");

    const longSelected = renderDisplay(model, { width: 80, maxRows: 4, selectedRow: 0, fixedHeight: true });
    const shortSelected = renderDisplay(model, { width: 80, maxRows: 4, selectedRow: 1, fixedHeight: true });
    const oneRow = renderDisplay(modelForResult("packages", [packages()[0]], "mason list"), { width: 80, maxRows: 4, selectedRow: 0, fixedHeight: true });

    expect(longSelected).toHaveLength(shortSelected.length);
    expect(oneRow).toHaveLength(longSelected.length);
    expect(oneRow.slice(5, 7).every((line) => line.trim().length === 0)).toBe(true);
  });

  test("moves selection, filters rows, and opens detail", async () => {
    const { host: fake } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();

    await tui.handleInput("down");
    expect(tui.render()).toContain("▶ lua-language-server");

    await tui.handleInput("/");
    for (const key of "st") await tui.handleInput(key);
    expect(tui.render()).toContain("lua-language-server");
    await tui.handleInput("y");
    expect(tui.render()).toContain("▶ stylua");
    expect(tui.render()).not.toContain("▶ lua-language-server");
    for (const key of "lua") await tui.handleInput(key);
    await tui.handleInput("enter");
    expect(tui.state.selectedIndex).toBe(0);
    expect(tui.render()).toContain("▶ stylua");
    expect(tui.render()).not.toContain("▶ lua-language-server");

    await tui.handleInput("enter");
    expect(tui.state.view).toBe("detail");
    const detail = tui.render();
    expect(detail).toContain("[list]");
    expect(detail).toContain("package details");
    expect(detail).toContain("Package: stylua");
    expect(detail).toContain("[i]: install");
    expect(detail).not.toContain("[u]: update");
    expect(detail).not.toContain("[r]: uninstall");
    await tui.handleInput("\x1b[27u");
    expect(tui.state.view).toBe("list");
    expect(tui.render()).not.toContain("package details");

    await tui.handleInput("enter");
    expect(tui.state.view).toBe("detail");
    await tui.handleInput("\x1b[27;1;27~");
    expect(tui.state.view).toBe("list");

    await tui.handleInput("enter");
    expect(tui.state.view).toBe("detail");
    await tui.handleInput("q");
    expect(tui.state.view).toBe("list");
  });

  test("renders theme-aware header and selected-row styling without changing visible width", async () => {
    const { host: fake } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();

    const lines = tui.renderLines(72, {
      tabBar: (text) => `\x1b[48;5;236m${text}\x1b[49m`,
      tabSeparator: (text) => `\x1b[38;5;244m${text}\x1b[39m`,
      activeTab: (text) => `\x1b[48;5;27m${text}\x1b[49m`,
      tableHeader: (text) => `\x1b[48;5;238m${text}\x1b[49m`,
      selectedRow: (text) => `\x1b[48;5;240m${text}\x1b[49m`,
      shortcutKey: (text) => `\x1b[38;5;39m${text}\x1b[39m`,
      shortcutAction: (text) => `\x1b[38;5;250m${text}\x1b[39m`,
    });

    expect(lines.join("\n")).toContain("\x1b[48;5;27m[list]");
    expect(lines.join("\n")).toContain("\x1b[38;5;244m  ╱  \x1b[39m");
    expect(lines.join("\n")).not.toContain("\x1b[48;5;27m  ╱");
    expect(lines.join("\n")).toContain("\x1b[48;5;240m▶ stylua");
    expect(lines.join("\n")).toContain("\x1b[38;5;39m[Tab/S-Tab/←→]/[↑↓/Pg]/[/]/[l]/[c]\x1b[39m");
    expect(lines.join("\n")).toContain("\x1b[38;5;250mbrowse\x1b[39m");
    expect(lines.every((line) => stripAnsi(line).length <= 72)).toBe(true);

    await tui.handleInput("enter");
    const detailLines = tui.renderLines(96, {
      detailLabel: (text) => `\x1b[38;5;244m${text}\x1b[39m`,
      detailName: (text) => `\x1b[38;5;39m${text}\x1b[39m`,
      detailActionKey: (text) => `\x1b[38;5;39m${text}\x1b[39m`,
    }).join("\n");
    expect(detailLines).toContain("\x1b[38;5;244mPackage: \x1b[39m\x1b[38;5;39mstylua\x1b[39m");
    expect(detailLines).toContain("\x1b[38;5;39m[i]\x1b[39m");
  });

  test("runs package actions from the selected row and refreshes", async () => {
    const { host: fake, calls, syncs } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();

    await tui.handleInput("i");
    await tui.handleInput("down");
    await tui.handleInput("u");
    await tui.handleInput("r");

    expect(calls).toContainEqual(["install", "stylua"]);
    expect(calls).toContainEqual(["update", "lua-language-server"]);
    expect(calls).toContainEqual(["uninstall", "lua-language-server"]);
    expect(syncs()).toBe(3);
  });

  test("renders suggested rows with installed marker and state-aware shortcuts", async () => {
    const { host: fake, calls } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();
    await tui.handleInput("tab");

    expect(tui.state.command).toBe("suggested");
    expect(calls).toContainEqual(["suggested"]);
    expect(tui.render()).toContain("Reason");
    expect(tui.render()).toContain("stylua");
    expect(tui.render()).toContain("✓");
    expect(tui.render()).toContain("[i]: install");
    expect(tui.render()).not.toContain("[u]: update");

    await tui.handleInput("down");
    const installedRender = tui.render();
    expect(installedRender).toContain("▶ ✓");
    expect(installedRender).toContain("[u]: update");
    expect(installedRender).toContain("[r]: uninstall");
    expect(installedRender).not.toContain("[i]: install");

    const styled = tui.renderLines(96, {
      installedMarker: (text) => `\x1b[32m${text}\x1b[39m`,
    });
    expect(styled.join("\n")).toContain("\x1b[32m✓\x1b[39m");
    expect(styled.every((line) => stripAnsi(line).length <= 96)).toBe(true);
  });

  test("switches tabs with tab and arrows", async () => {
    const { host: fake, calls } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();

    expect(MASON_TUI_COMMANDS.map((command) => command.label)).toEqual(["list", "suggested", "installed", "check update", "refresh", "doctor"]);
    expect(tui.state.command).toBe("list");
    expect(tui.render()).toContain("╱");
    expect(tui.render()).toContain("[c]: cat │ [Enter]: detail");
    expect(tui.render()).toContain("[i]: install");
    expect(tui.render()).not.toContain("showing 1-");
    await tui.handleInput("tab");
    expect(tui.state.command).toBe("suggested");
    expect(tui.render()).toContain("[suggested]");
    expect(tui.render()).toContain("Reason");
    expect(tui.render()).toContain("[i]: install");
    expect(calls).toContainEqual(["suggested"]);
    await tui.handleInput("right");
    expect(tui.state.command).toBe("installed");
    expect(tui.render()).toContain("[Tab/S-Tab/←→]: tabs │ [↑↓/Pg]: move │ [/]: name │ [Enter]: detail │ [u]: update │ [r]: uninstall");
    expect(tui.render()).not.toContain("[l]: lang");
    await tui.handleInput("right");
    expect(tui.state.command).toBe("update");
    expect(tui.render()).toContain("[check update]");
    expect(tui.render()).toContain("[c]: cat");
    expect(calls).toContainEqual(["list", "--outdated"]);
    await tui.handleInput("right");
    expect(tui.state.command).toBe("refresh");
    expect(tui.render()).toContain("[r]: refresh registry");
    expect(calls).not.toContainEqual(["refresh"]);
    await tui.handleInput("r");
    expect(calls).toContainEqual(["refresh"]);
    await tui.handleInput("\x1b[9;2u");
    expect(tui.state.command).toBe("update");
    await tui.handleInput("\x1b[27;2;9~");
    expect(tui.state.command).toBe("installed");
    await tui.handleInput("left");
    expect(tui.state.command).toBe("suggested");
    await tui.handleInput("left");
    expect(tui.state.command).toBe("list");
  });

  test("filters list rows by name, language, and category without running search", async () => {
    const calls: string[][] = [];
    const fake: MasonTuiHost = {
      async runCli(args: string[]) {
        calls.push(args);
        return [
          ...packages(),
          {
            name: "typescript-language-server",
            version: "v4.0.0",
            installed: false,
            installed_version: null,
            outdated: false,
            deprecated: false,
            languages: ["TypeScript", "JavaScript"],
            categories: ["LSP"],
            description: "TypeScript LSP",
          },
        ];
      },
    };
    const tui = createMasonTui(fake);
    await tui.runCurrent();

    await tui.handleInput("c");
    expect(tui.render()).toContain("select category");
    expect(tui.render()).toContain("All categories");
    expect(tui.render()).toContain("Formatter");
    expect(tui.render()).toContain("LSP");
    await tui.handleInput("down");
    await tui.handleInput("down");
    await tui.handleInput("enter");

    expect(tui.state.category).toBe("LSP");
    expect(tui.render()).toContain("[c LSP]");
    expect(tui.render()).toContain("lua-language-server");
    expect(tui.render()).toContain("typescript-language-server");
    expect(tui.render()).not.toContain("▶ stylua");
    expect(calls).toEqual([["list"]]);

    await tui.handleInput("/");
    for (const key of "typ") await tui.handleInput(key);
    expect(tui.render()).toContain("typescript-language-server");
    expect(tui.render()).not.toContain("lua-language-server");
    await tui.handleInput("enter");
    expect(tui.render()).toContain("[/ typ]");
    expect(tui.render()).toContain("[c LSP]");
    expect(calls).toEqual([["list"]]);

    await tui.handleInput("/");
    for (let index = 0; index < "typ".length; index += 1) await tui.handleInput("backspace");
    await tui.handleInput("enter");
    expect(tui.render()).not.toContain("[/ typ]");

    await tui.handleInput("l");
    expect(tui.render()).toContain("select language");
    expect(tui.render()).toContain("JavaScript");
    expect(tui.render()).toContain("Lua");
    expect(tui.render()).toContain("TypeScript");
    await tui.handleInput("/");
    for (const key of "typ") await tui.handleInput(key);
    expect(tui.render()).toContain("[/ typ]");
    await tui.handleInput("enter");

    expect(tui.state.edit).toBeUndefined();
    expect(tui.render()).not.toContain("select language");

    expect(tui.state.language).toBe("TypeScript");
    expect(tui.render()).toContain("[l TypeScript]");
    expect(tui.render()).toContain("[c LSP]");
    expect(tui.render()).toContain("typescript-language-server");
    expect(tui.render()).not.toContain("lua-language-server");
    expect(calls).toEqual([["list"]]);
  });

  test("keeps the TUI canvas height stable across command views", async () => {
    const { host: fake } = host();
    const tui = createMasonTui(fake);
    await tui.runCurrent();
    const expectedHeight = tui.renderLines(120).length;
    const commands = MASON_TUI_COMMANDS.map((item) => item.id);

    for (const command of commands) {
      tui.state.command = command;
      tui.state.commandIndex = MASON_TUI_COMMANDS.findIndex((item) => item.id === command);
      await tui.runCurrent();
      const lines = tui.renderLines(120);
      expect(lines).toHaveLength(expectedHeight);
      expect(lines[1]).toContain(`[${MASON_TUI_COMMANDS[tui.state.commandIndex]!.label}]`);
    }
  });

  test("ignores stale command results from overlapping tab changes", async () => {
    const pending: Array<{ args: string[]; resolve: (value: unknown) => void }> = [];
    const fake: MasonTuiHost = {
      runCli(args) {
        return new Promise((resolve) => {
          pending.push({ args, resolve });
        });
      },
    };
    const tui = createMasonTui(fake);

    const firstInstalled = tui.handleInput("tab");
    const firstList = tui.handleInput("left");
    const secondInstalled = tui.handleInput("right");
    const secondList = tui.handleInput("left");

    expect(pending.map((item) => item.args)).toEqual([
      ["suggested"],
      ["list"],
      ["suggested"],
      ["list"],
    ]);
    pending[3]!.resolve(packages());
    await secondList;
    expect(tui.state.command).toBe("list");
    expect(tui.render()).toContain("Description");
    expect(tui.render()).not.toContain("Installed At");

    pending[2]!.resolve(suggestions());
    await secondInstalled;
    expect(tui.state.command).toBe("list");
    expect(tui.render()).toContain("Description");
    expect(tui.render()).not.toContain("Installed At");

    pending[1]!.resolve(packages());
    await firstList;
    expect(tui.state.command).toBe("list");
    expect(tui.render()).toContain("Description");
    expect(tui.render()).not.toContain("Installed At");

    pending[0]!.resolve(suggestions());
    await firstInstalled;
    expect(tui.state.command).toBe("list");
    expect(tui.render()).toContain("Description");
    expect(tui.render()).not.toContain("Installed At");
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
