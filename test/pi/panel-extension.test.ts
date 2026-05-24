import { afterEach, describe, expect, test } from "bun:test";
import type { CliBridge } from "../../src/pi/cli";
import { activate } from "../../src/pi/extension";
import { createMasonPanel } from "../../src/pi/mason-panel";
import { mkdtempSync, rmSync } from "node:fs";
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
      if (args[0] === "search") return [{ name: "stylua", version: "v2.0.0", installed: false, categories: ["Formatter"] }];
      return { args };
    }
  };
  return { bridge: fake, calls };
}

describe("Mason panel", () => {
  test("searches, renders, installs, uninstalls, updates, and doctors through bridge", async () => {
    const { bridge: fake, calls } = bridge();
    const panel = createMasonPanel(fake);
    await panel.search("lua", { category: "Formatter", language: "Lua" });
    expect(panel.render()).toContain("stylua");
    await panel.install(["stylua"]);
    await panel.uninstall(["stylua"]);
    await panel.update(["stylua"]);
    await panel.doctor();
    expect(calls).toContainEqual(["install", "stylua"]);
    expect(calls).toContainEqual(["uninstall", "stylua"]);
    expect(calls).toContainEqual(["update", "stylua"]);
    expect(calls).toContainEqual(["doctor"]);
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
    const ctx = {
      commands: { registerCommand(name: string) { commands.push(name); } },
      tools: { registerTool(definition: { name: string }) { tools.push(definition.name); } },
      events: { on(name: string) { events.push(name); } }
    };
    try {
      const { bridge: fake } = bridge();
      const result = await activate(ctx, fake);
      expect(result.name).toBe("mason4agents");
      expect(commands).toEqual(["mason", "mason-doctor"]);
      expect(tools).toContain("mason_install");
      expect(events).toEqual(["session_start"]);
      expect((process.env.PATH ?? "").startsWith(result.binDir)).toBe(true);
    } finally {
      process.env.HOME = oldHome;
      if (oldData === undefined) delete process.env.MASON4AGENTS_DATA_HOME; else process.env.MASON4AGENTS_DATA_HOME = oldData;
      process.env.PATH = oldPath;
    }
  });
});
