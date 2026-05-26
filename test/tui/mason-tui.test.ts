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
    async runCli(args: string[], options) {
      calls.push(args);
      const command = args[0];
      if (command === "install" || command === "update" || command === "uninstall" || command === "refresh") {
        options?.onProgress?.({
          kind: "progress",
          schema_version: 1,
          operation: command,
          phase: command === "refresh" ? "registry" : "package",
          status: "running",
          ...(args[1] === undefined ? {} : { package: args[1] }),
          message: `${command} running`,
          elapsed_ms: 1,
        });
      }
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
      if (args[0] === "install" || args[0] === "update") return [{ package: args[1], version: "v1.0.0", source_id: `pkg:generic/acme/${args[1]}@v1.0.0`, bins: {}, package_dir: `/tmp/${args[1]}` }];
      if (args[0] === "uninstall") return [{ package: args[1], removed: true }];
      if (args[0] === "refresh") return { source: "fixture", package_count: 2, cache_file: "/tmp/registry.json", checksum: "abc" };
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
    expect(tui.render()).toContain("operation result");
    expect(tui.render()).toContain("mason install stylua");
    await tui.handleInput("q");
    await tui.handleInput("down");
    await tui.handleInput("u");
    await tui.handleInput("q");
    await tui.handleInput("r");
    await tui.handleInput("q");

    expect(calls).toContainEqual(["install", "stylua"]);
    expect(calls).toContainEqual(["update", "lua-language-server"]);
    expect(calls).toContainEqual(["uninstall", "lua-language-server"]);
    expect(syncs()).toBe(3);
  });

  test("shows progress modal, blocks input, times out, and keeps final result", async () => {
    let resolveInstall!: (value: unknown) => void;
    const calls: string[][] = [];
    const fake: MasonTuiHost = {
      runCli(args, options) {
        calls.push(args);
        if (args[0] === "install") {
          options?.onProgress?.({
            kind: "progress",
            schema_version: 1,
            operation: "install",
            phase: "download",
            status: "running",
            package: "stylua",
            message: "downloaded 256 KiB / 1.0 MiB (25.0%) at 128 KiB/s",
            elapsed_ms: 1,
            total_bytes: 1048576,
            downloaded_bytes: 262144,
            download_percent: 25,
            bytes_per_second: 131072,
          });
          return new Promise((resolve) => {
            resolveInstall = resolve;
          });
        }
        if (args[0] === "list") return Promise.resolve(packages());
        return Promise.resolve({ args });
      },
      syncAfterPackageChange() {},
    };
    const tui = createMasonTui(fake, { progressTimeoutMs: 0 });

    const pending = tui.install(["stylua"]);
    const progressLines = tui.renderLines(80).map(stripAnsi);
    expect(progressLines.join("\n")).toContain("operation progress");
    expect(progressLines.join("\n")).toContain("download");
    const progressTitleLine = progressLines.find((line) => line.includes("operation progress"));
    expect(progressTitleLine?.trim().length).toBe(40);
    await tui.handleInput("down");
    expect(tui.state.selectedIndex).toBe(0);
    expect(tui.render()).toContain("No progress for 0s");
    await tui.handleInput("q");
    expect(tui.render()).not.toContain("operation progress");

    resolveInstall([{ package: "stylua", version: "v2.0.0", source_id: "pkg:generic/acme/stylua@v2.0.0", bins: {}, package_dir: "/tmp/stylua" }]);
    await pending;

    expect(calls).toEqual([["install", "stylua"], ["list"]]);
    expect(tui.render()).toContain("operation result");
    expect(tui.render()).toContain("stylua");
    await tui.handleInput("q");
    expect(tui.state.progress).toBeUndefined();
  });
  test("keeps the existing list behind the result popup while refresh is pending", async () => {
    let resolveRefreshedList!: (value: unknown) => void;
    let listCalls = 0;
    const fake: MasonTuiHost = {
      runCli(args, options) {
        if (args[0] === "list") {
          listCalls += 1;
          if (listCalls === 1) return Promise.resolve(packages());
          return new Promise((resolve) => {
            resolveRefreshedList = resolve;
          });
        }
        if (args[0] === "install") {
          options?.onProgress?.({
            kind: "progress",
            schema_version: 1,
            operation: "install",
            phase: "package",
            status: "running",
            package: "stylua",
            message: "installing",
            elapsed_ms: 1,
          });
          return Promise.resolve([
            {
              package: "stylua",
              version: "v2.0.0",
              source_id: "pkg:generic/acme/stylua@v2.0.0",
              bins: {},
              package_dir: "/tmp/stylua",
            },
          ]);
        }
        return Promise.resolve({ args });
      },
      syncAfterPackageChange() {},
    };
    const tui = createMasonTui(fake);

    await tui.runCurrent();
    expect(tui.render()).toContain("Lua formatter");

    const pending = tui.install(["stylua"]);
    await Promise.resolve();
    await Promise.resolve();

    const duringPopup = tui.render();
    expect(duringPopup).toContain("operation result");
    expect(duringPopup).toContain("2 packages");
    expect(duringPopup).toContain("Description");
    expect(duringPopup).not.toContain("Loading...");

    resolveRefreshedList(packages());
    await pending;
  });
  test("keeps popup height stable from active progress to result state", async () => {
    let resolveInstall!: (value: unknown) => void;
    let resolveList!: (value: unknown) => void;
    const fake: MasonTuiHost = {
      runCli(args, options) {
        if (args[0] === "install") {
          options?.onProgress?.({
            kind: "progress",
            schema_version: 1,
            operation: "install",
            phase: "download",
            status: "running",
            package: "stylua",
            message: "downloaded 256 KiB / 1.0 MiB (25.0%) at 128 KiB/s",
            elapsed_ms: 1,
            total_bytes: 1048576,
            downloaded_bytes: 262144,
            download_percent: 25,
            bytes_per_second: 131072,
          });
          return new Promise((resolve) => {
            resolveInstall = resolve;
          });
        }
        if (args[0] === "list") {
          return new Promise((resolve) => {
            resolveList = resolve;
          });
        }
        return Promise.resolve({ args });
      },
      syncAfterPackageChange() {},
    };
    const tui = createMasonTui(fake);

    const pending = tui.install(["stylua"]);
    const activeLines = tui.renderLines(80).map(stripAnsi);
    const activeTop = activeLines.findIndex((line) => line.includes("operation progress"));
    const activeBottom = activeLines.findIndex((line) => line.includes("╰"));
    expect(activeTop).toBeGreaterThanOrEqual(0);
    expect(activeBottom).toBeGreaterThan(activeTop);

    resolveInstall([
      {
        package: "stylua",
        version: "v2.0.0",
        source_id: "pkg:generic/acme/stylua@v2.0.0",
        bins: {},
        package_dir: "/tmp/stylua",
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    const resultLines = tui.renderLines(80).map(stripAnsi);
    const resultTop = resultLines.findIndex((line) => line.includes("operation result"));
    const resultBottom = resultLines.findIndex((line) => line.includes("╰"));
    expect(resultTop).toBe(activeTop);
    expect(resultBottom).toBe(activeBottom);

    resolveList(packages());
    await pending;
  });
  test("scrolls long progress popup content without resizing it", async () => {
    let resolveInstall!: (value: unknown) => void;
    const fake: MasonTuiHost = {
      runCli(args, options) {
        if (args[0] === "install") {
          for (let index = 1; index <= 20; index += 1) {
            options?.onProgress?.({
              kind: "progress",
              schema_version: 1,
              operation: "install",
              phase: "download",
              status: "running",
              package: "stylua",
              message: `chunk ${String(index).padStart(2, "0")}`,
              elapsed_ms: index,
            });
          }
          return new Promise((resolve) => {
            resolveInstall = resolve;
          });
        }
        return Promise.resolve({ args });
      },
    };
    const tui = createMasonTui(fake, { progressTimeoutMs: 60_000 });

    const pending = tui.runProgress(["install", "stylua"], "install", "mason install");
    const beforeScroll = tui.renderLines(80).map(stripAnsi);
    const beforeTop = beforeScroll.findIndex((line) => line.includes("operation progress"));
    const beforeBottom = beforeScroll.findIndex((line) => line.includes("╰"));
    expect(beforeScroll.join("\n")).toContain("chunk 20");
    expect(beforeScroll.join("\n")).not.toContain("chunk 01");

    await tui.handleInput("pageup");

    const afterScroll = tui.renderLines(80).map(stripAnsi);
    const afterTop = afterScroll.findIndex((line) => line.includes("operation progress"));
    const afterBottom = afterScroll.findIndex((line) => line.includes("╰"));
    expect(afterScroll.join("\n")).toContain("chunk 01");
    expect(afterTop).toBe(beforeTop);
    expect(afterBottom).toBe(beforeBottom);

    resolveInstall([
      {
        package: "stylua",
        version: "v2.0.0",
        source_id: "pkg:generic/acme/stylua@v2.0.0",
        bins: {},
        package_dir: "/tmp/stylua",
      },
    ]);
    await pending;
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
    await tui.handleInput("q");
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
