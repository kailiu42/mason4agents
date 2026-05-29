import { describe, expect, test } from "bun:test";
import type { CliBridge } from "../../src/pi/cli";
import { createPiTools } from "../../src/pi/pi-tools";

function fakeBridge() {
  const calls: string[][] = [];
  const bridge: CliBridge = {
    async run(args: string[]) {
      calls.push(args);
      return { args };
    }
  };
  return { bridge, calls };
}

describe("Pi tools", () => {
  test("expose schemas and map inputs to CLI argv", async () => {
    const { bridge, calls } = fakeBridge();
    let syncs = 0;
    const tools = createPiTools(bridge, { syncLspConfig: () => { syncs += 1; } });
    expect(tools.map((tool) => tool.name)).toEqual([
      "mason_list",
      "mason_search",
      "mason_install",
      "mason_uninstall",
      "mason_update",
      "mason_which",
      "mason_env"
    ]);
    expect(tools.find((tool) => tool.name === "mason_install")?.parameters).toMatchObject({ type: "object" });
    expect(tools.find((tool) => tool.name === "mason_list")?.parameters).toMatchObject({ properties: { registry: { type: "string" } } });
    expect(tools.find((tool) => tool.name === "mason_search")?.parameters).toMatchObject({ properties: { registry: { type: "string" } } });

    await tools.find((tool) => tool.name === "mason_list")!.execute("0", {});
    await tools.find((tool) => tool.name === "mason_search")!.execute("1", { query: "lua", category: "LSP", language: "Lua" });
    await tools.find((tool) => tool.name === "mason_install")!.execute("2", { packages: ["stylua"], registry: "file:///tmp/reg", allow_build_scripts: true });
    await tools.find((tool) => tool.name === "mason_uninstall")!.execute("3", { packages: ["stylua"] });
    await tools.find((tool) => tool.name === "mason_update")!.execute("4", { packages: [] });
    await tools.find((tool) => tool.name === "mason_which")!.execute("5", { executable: "stylua" });
    await tools.find((tool) => tool.name === "mason_env")!.execute("6", { shell: "bash" });

    expect(calls).toEqual([
      ["list"],
      ["search", "lua", "--category", "LSP", "--language", "Lua"],
      ["install", "stylua", "--registry", "file:///tmp/reg", "--allow-build-scripts"],
      ["uninstall", "stylua"],
      ["update"],
      ["which", "stylua"],
      ["env", "--shell", "bash"]
    ]);
    expect(syncs).toBe(3);
  });

  test("forwards list and search registry when non-empty", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = createPiTools(bridge);

    await tools.find((tool) => tool.name === "mason_list")!.execute("1", { registry: "file:///tmp/registry" });
    await tools.find((tool) => tool.name === "mason_search")!.execute("2", { query: "lua", registry: "file:///tmp/registry" });

    expect(calls).toEqual([
      ["list", "--registry", "file:///tmp/registry"],
      ["search", "lua", "--registry", "file:///tmp/registry"]
    ]);
  });

  test("does not forward empty list and search registry", async () => {
    const { bridge, calls } = fakeBridge();
    const tools = createPiTools(bridge);

    await tools.find((tool) => tool.name === "mason_list")!.execute("1", { installed: true, registry: "" });
    await tools.find((tool) => tool.name === "mason_search")!.execute("2", { query: "lua", registry: "" });

    expect(calls).toEqual([
      ["list", "--installed"],
      ["search", "lua"]
    ]);
  });

  test("rejects conflicting list filters", async () => {
    const { bridge, calls } = fakeBridge();
    const list = createPiTools(bridge).find((tool) => tool.name === "mason_list")!;

    await expect(list.execute("1", { installed: true, outdated: true })).rejects.toThrow(
      "installed and outdated filters are mutually exclusive"
    );
    expect(calls).toEqual([]);
  });

  test("accepts single list filters", async () => {
    const { bridge, calls } = fakeBridge();
    const list = createPiTools(bridge).find((tool) => tool.name === "mason_list")!;

    await list.execute("1", { installed: true });
    await list.execute("2", { outdated: true });

    expect(calls).toEqual([
      ["list", "--installed"],
      ["list", "--outdated"]
    ]);
  });

  test("validates required tool inputs", async () => {
    const { bridge } = fakeBridge();
    const install = createPiTools(bridge).find((tool) => tool.name === "mason_install")!;
    await expect(install.execute("1", { packages: [] })).rejects.toThrow("packages must be a non-empty string array");
    const which = createPiTools(bridge).find((tool) => tool.name === "mason_which")!;
    await expect(which.execute("2", { executable: "" })).rejects.toThrow("executable must be a non-empty string");
  });
});
