import { afterEach, describe, expect, test } from "bun:test";
import type { CliBridge } from "../../src/pi/cli";
import { activate } from "../../src/pi/extension";
import { createMasonPanel, openMasonPanel } from "../../src/pi/mason-panel";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bridge() {
  const calls: string[][] = [];
  const fake: CliBridge = {
    async run(args: string[]) {
      calls.push(args);
      if (args[0] === "search") {
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
          },
        ];
      }
      if (args[0] === "list" && args.includes("--installed")) {
        return [
          {
            name: "lua-language-server",
            version: "v3.8.0",
            source_id: "pkg:github/lua-language-server@v3.8.0",
            bins: { "lua-language-server": "bin/lua-language-server" },
            share: {},
            opt: {},
            installed_at: "2026-05-24T00:00:00Z",
          },
        ];
      }
      if (args[0] === "list") {
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
          },
        ];
      }
      if (args[0] === "doctor") {
        return {
          ok: true,
          paths: { bin_dir: "/tmp/bin", bin_dir_exists: true, data_dir_writable: true },
          registry: { cache_present: true, package_count: 2 },
          path_env: { contains_bin_dir: true, bin_dir_first: true },
          managers: [{ source_type: "npm", available: true }],
        };
      }
      return { args };
    }
  };
  return { bridge: fake, calls };
}

function fakeTheme() {
  return {
    fg(_token: string, text: string) {
      return `\x1b[38;5;250m${text}\x1b[39m`;
    },
    bg(_token: string, text: string) {
      return `\x1b[48;5;236m${text}\x1b[49m`;
    },
    bold(text: string) {
      return `\x1b[1m${text}\x1b[22m`;
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

async function waitForInitialPanelLoad(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

describe("Mason panel", () => {
  test("searches, renders tables, installs, uninstalls, updates, and doctors through bridge", async () => {
    const { bridge: fake, calls } = bridge();
    let syncs = 0;
    const panel = createMasonPanel(fake, { syncLspConfig: () => { syncs += 1; } });
    await panel.search("lua", { category: "Formatter", language: "Lua" });
    const rendered = panel.render();
    expect(rendered).toContain("stylua");
    expect(rendered).toContain("Status");
    expect(rendered).toContain("language=Lua");
    await panel.install(["stylua"]);
    await panel.uninstall(["stylua"]);
    await panel.update(["stylua"]);
    await panel.doctor();
    expect(calls).toContainEqual(["search", "lua", "--category", "Formatter", "--language", "Lua"]);
    expect(calls).toContainEqual(["install", "stylua"]);
    expect(calls).toContainEqual(["uninstall", "stylua"]);
    expect(calls).toContainEqual(["update", "stylua"]);
    expect(calls).toContainEqual(["doctor"]);
    expect(syncs).toBe(3);
  });

  test("filters locally, edits language, and shows installed table state", async () => {
    const { bridge: fake, calls } = bridge();
    const panel = createMasonPanel(fake);
    await panel.runCurrent();

    await panel.handleInput("/");
    await panel.handleInput("l");
    await panel.handleInput("a");
    await panel.handleInput("n");
    await panel.handleInput("g");
    await panel.handleInput("enter");
    expect(panel.render()).toContain("lua-language-server");
    expect(panel.render()).not.toContain("stylua");

    await panel.handleInput("/");
    for (let index = 0; index < "lang".length; index += 1) await panel.handleInput("backspace");
    await panel.handleInput("enter");
    const callCount = calls.length;
    await panel.handleInput("l");
    await panel.handleInput("L");
    await panel.handleInput("u");
    await panel.handleInput("a");
    await panel.handleInput("enter");
    expect(panel.render()).toContain("language=Lua");
    expect(calls).toHaveLength(callCount);

    await panel.handleInput("tab");
    expect(panel.render()).toContain("Installed At");
    expect(panel.render()).toContain("lua-language-server");
  });

  test("runCurrent syncs LSP config for package-changing commands", async () => {
    const { bridge: fake, calls } = bridge();
    let syncs = 0;
    const panel = createMasonPanel(fake, { syncLspConfig: () => { syncs += 1; } });
    panel.state.command = "install";
    panel.state.commandIndex = 3;
    panel.state.inputs.install = "stylua";

    await panel.runCurrent();

    expect(calls).toContainEqual(["install", "stylua"]);
    expect(syncs).toBe(1);
  });

  test("renders custom UI as line arrays with bounded width", async () => {
    const { bridge: fake } = bridge();
    let component: { render(width: number): unknown; handleInput(...keys: unknown[]): void } | undefined;
    let customOptions: unknown;
    let closed = false;
    const ctx = {
      hasUI: true,
      ui: {
        custom(factory: Function, options: unknown) {
          customOptions = options;
          component = factory({ requestRender() {} }, fakeTheme(), undefined, () => { closed = true; });
        },
      },
    };

    await openMasonPanel(ctx, fake);
    component?.render(24);
    await waitForInitialPanelLoad();
    const lines = component?.render(24);

    expect(customOptions).toMatchObject({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "90%", anchor: "top-center" },
    });
    expect(Array.isArray(lines)).toBe(true);
    expect((lines as string[]).join("\n")).toContain("[list]");
    expect((lines as string[]).join("\n")).toContain("stylua");
    expect((lines as string[]).every((line) => stripAnsi(line).length <= 24)).toBe(true);
    component?.handleInput("/");
    expect((component?.render(24) as string[]).join("\n")).toContain("name>");
    component?.handleInput("\x1b[27u");
    component?.handleInput("enter");
    expect((component?.render(48) as string[]).join("\n")).toContain("package details");
    component?.handleInput("\x1b[27;1;27~");
    expect((component?.render(48) as string[]).join("\n")).not.toContain("package details");
    component?.handleInput("tab");
    await Promise.resolve();
    expect((component?.render(48) as string[]).join("\n")).toContain("[installed]");
    component?.handleInput("\x1b[9;2u");
    await Promise.resolve();
    expect((component?.render(48) as string[]).join("\n")).toContain("[list]");
    component?.handleInput("q");
    await Promise.resolve();
    expect(closed).toBe(true);
  });

  test("opens custom UI before initial list starts", async () => {
    let resolveRun!: (value: unknown) => void;
    const calls: string[][] = [];
    const fake: CliBridge = {
      run(args: string[]) {
        calls.push(args);
        return new Promise((resolve) => { resolveRun = resolve; });
      },
    };
    let component: { render(width: number): unknown } | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        custom(factory: Function) {
          component = factory({ requestRender() {} }, fakeTheme(), undefined, () => {});
        },
      },
    };

    await openMasonPanel(ctx, fake);
    expect(component).toBeDefined();
    expect(calls).toEqual([]);
    expect((component?.render(48) as string[]).join("\n")).toContain("Loading...");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["list"]]);
    expect((component?.render(48) as string[]).join("\n")).toContain("Loading...");

    resolveRun([
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
    await Promise.resolve();
    await Promise.resolve();
    expect((component?.render(48) as string[]).join("\n")).toContain("stylua");
  });
});

describe("Pi extension", () => {
  test("registers commands, tools, session_start, and injects PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "m4a-ext-"));
    roots.push(root);
    const oldHome = process.env.HOME;
    const oldData = process.env.MASON4AGENTS_DATA_HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = root;
    process.env.MASON4AGENTS_DATA_HOME = join(root, "data");
    process.env.PATH = "/usr/bin";
    const commands: string[] = [];
    const tools: string[] = [];
    const events: string[] = [];
    const handlers: Record<string, (args: string, commandCtx: unknown) => Promise<unknown> | unknown> = {};
    const messages: unknown[] = [];
    const ctx = {
      commands: {
        registerCommand(name: string, options: { handler: (args: string, commandCtx: unknown) => Promise<unknown> | unknown }) {
          commands.push(name);
          handlers[name] = options.handler;
        },
      },
      tools: { registerTool(definition: { name: string }) { tools.push(definition.name); } },
      events: { on(name: string) { events.push(name); } },
      sendMessage(message: unknown) { messages.push(message); },
      sendUserMessage() { throw new Error("mason commands must not trigger agent turns"); }
    };
    try {
      const { bridge: fake } = bridge();
      const result = await activate(ctx, fake);
      expect(result.name).toBe("mason4agents");
      expect(commands).toEqual(["mason", "mason-doctor"]);
      expect(tools).toContain("mason_install");
      expect(events).toEqual(["session_start"]);
      expect((process.env.PATH ?? "").startsWith(result.binDir)).toBe(true);
      const workingVisible: boolean[] = [];
      const commandCtx = {
        hasUI: false,
        ui: { setWorkingVisible(value: boolean) { workingVisible.push(value); } },
      };
      await handlers.mason?.("", commandCtx);
      await handlers.mason?.("search stylua --language Lua", commandCtx);
      await handlers["mason-doctor"]?.("", commandCtx);
      expect(messages).toHaveLength(3);
      expect(workingVisible).toEqual([false, true, false, true, false, true]);
      expect(messages[0]).toMatchObject({ customType: "mason4agents", display: true });
      expect(messages[1]).toMatchObject({ customType: "mason4agents", display: true });
      expect(String((messages[1] as { content?: unknown }).content)).toContain("stylua");
      expect(String((messages[1] as { content?: unknown }).content)).not.toContain("{");
      expect(messages[2]).toMatchObject({ customType: "mason4agents-doctor", display: true });
    } finally {
      process.env.HOME = oldHome;
      if (oldData === undefined) delete process.env.MASON4AGENTS_DATA_HOME; else process.env.MASON4AGENTS_DATA_HOME = oldData;
      process.env.PATH = oldPath;
    }
  });

  test("default bridge resolves binaries from OMP original extension path", async () => {
    const root = mkdtempSync(join(tmpdir(), "m4a-ext-"));
    roots.push(root);
    const oldHome = process.env.HOME;
    const oldData = process.env.MASON4AGENTS_DATA_HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = root;
    process.env.MASON4AGENTS_DATA_HOME = join(root, "data");
    process.env.PATH = "/usr/bin";
    const packageRoot = join(root, "pkg");
    const native = join(packageRoot, "native", process.platform === "win32" ? `mason4agents-${process.platform}-${process.arch}.exe` : `mason4agents-${process.platform}-${process.arch}`);
    mkdirSync(join(packageRoot, "dist", "pi"), { recursive: true });
    mkdirSync(join(packageRoot, "native"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "mason4agents" }));
    writeFileSync(native, `#!/bin/sh\nprintf '%s\\n' '{"ok":true,"data":{"ok":true,"paths":{"bin_dir":"/tmp/bin","bin_dir_exists":true,"data_dir_writable":true},"registry":{"cache_present":true,"package_count":1},"path_env":{"contains_bin_dir":true,"bin_dir_first":true},"managers":[]}}'\n`);
    chmodSync(native, 0o755);
    const handlers: Record<string, (args: string, commandCtx: unknown) => Promise<unknown> | unknown> = {};
    const messages: unknown[] = [];
    const ctx = {
      extension: { resolvedPath: join(packageRoot, "dist", "pi", "extension.js") },
      commands: {
        registerCommand(name: string, options: { handler: (args: string, commandCtx: unknown) => Promise<unknown> | unknown }) {
          handlers[name] = options.handler;
        },
      },
      tools: { registerTool() {} },
      events: { on() {} },
      sendMessage(message: unknown) { messages.push(message); },
    };
    try {
      await activate(ctx);
      await handlers["mason-doctor"]?.("", { hasUI: false });
      expect(messages).toHaveLength(1);
      expect(String((messages[0] as { content?: unknown }).content)).toContain("Overall: ok");
    } finally {
      process.env.HOME = oldHome;
      if (oldData === undefined) delete process.env.MASON4AGENTS_DATA_HOME; else process.env.MASON4AGENTS_DATA_HOME = oldData;
      process.env.PATH = oldPath;
    }
  });

  test("direct command errors publish and return without opening custom UI", async () => {
    const root = mkdtempSync(join(tmpdir(), "m4a-ext-"));
    roots.push(root);
    const oldHome = process.env.HOME;
    const oldData = process.env.MASON4AGENTS_DATA_HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = root;
    process.env.MASON4AGENTS_DATA_HOME = join(root, "data");
    process.env.PATH = "/usr/bin";
    const handlers: Record<string, (args: string, commandCtx: unknown) => Promise<unknown> | unknown> = {};
    const messages: unknown[] = [];
    let customCalls = 0;
    const ctx = {
      commands: {
        registerCommand(name: string, options: { handler: (args: string, commandCtx: unknown) => Promise<unknown> | unknown }) {
          handlers[name] = options.handler;
        },
      },
      tools: { registerTool() {} },
      events: { on() {} },
      sendMessage(message: unknown) { messages.push(message); },
    };
    const failing: CliBridge = {
      async run() {
        throw new Error("Unable to locate mason4agents native binary.");
      },
    };
    const commandCtx = {
      hasUI: true,
      ui: {
        custom() {
          customCalls += 1;
          throw new Error("direct commands must not open custom UI");
        },
      },
    };
    try {
      await activate(ctx, failing);
      await handlers.mason?.("doctor", commandCtx);
      await handlers["mason-doctor"]?.("", commandCtx);
      expect(customCalls).toBe(0);
      expect(messages).toHaveLength(2);
      expect(String((messages[0] as { content?: unknown }).content)).toContain("Error: Unable to locate mason4agents native binary.");
      expect(messages[1]).toMatchObject({ customType: "mason4agents-doctor", display: true });
    } finally {
      process.env.HOME = oldHome;
      if (oldData === undefined) delete process.env.MASON4AGENTS_DATA_HOME; else process.env.MASON4AGENTS_DATA_HOME = oldData;
      process.env.PATH = oldPath;
    }
  });

  test("direct install command syncs OMP LSP config after package changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "m4a-ext-"));
    roots.push(root);
    const oldHome = process.env.HOME;
    const oldData = process.env.MASON4AGENTS_DATA_HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = root;
    process.env.MASON4AGENTS_DATA_HOME = join(root, "data");
    process.env.PATH = "/usr/bin";
    const binDir = join(root, "data", "mason4agents", "bin");
    const handlers: Record<string, (args: string, commandCtx: unknown) => Promise<unknown> | unknown> = {};
    const ctx = {
      commands: {
        registerCommand(name: string, options: { handler: (args: string, commandCtx: unknown) => Promise<unknown> | unknown }) {
          handlers[name] = options.handler;
        },
      },
      tools: { registerTool() {} },
      events: { on() {} },
      sendMessage() {},
    };
    const installing: CliBridge = {
      async run(args: string[]) {
        if (args[0] === "install") {
          mkdirSync(binDir, { recursive: true });
          writeFileSync(join(binDir, "rust-analyzer"), "");
        }
        return { args };
      },
    };
    try {
      await activate(ctx, installing);
      await handlers.mason?.("install rust-analyzer", { hasUI: false });
      const generated = JSON.parse(readFileSync(join(root, ".omp", "agent", "lsp.json"), "utf8")) as {
        servers?: Record<string, { command?: string }>;
      };
      expect(generated.servers?.["rust-analyzer"]?.command).toBe(join(binDir, "rust-analyzer"));
    } finally {
      process.env.HOME = oldHome;
      if (oldData === undefined) delete process.env.MASON4AGENTS_DATA_HOME; else process.env.MASON4AGENTS_DATA_HOME = oldData;
      process.env.PATH = oldPath;
    }
  });
});
