import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MasonCliError, runCliJson } from "../../src/pi/cli";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeBinary(): string {
  const root = mkdtempSync(join(tmpdir(), "m4a-bridge-"));
  roots.push(root);
  const bin = join(root, "fake-cli.js");
  writeFileSync(bin, `#!/usr/bin/env bun\nconst args = process.argv.slice(2);\nif (args[0] === "fail") { console.log(JSON.stringify({ ok: false, error: { code: "bad", message: "failed" } })); process.exit(7); }\nif (args[0] === "invalid") { console.log("not json"); process.exit(0); }\nif (args[0] === "sleep") { await new Promise((resolve) => setTimeout(resolve, 5000)); }\nconsole.log(JSON.stringify({ ok: true, data: { args } }));\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("Rust CLI bridge", () => {
  test("adds --json and parses successful envelopes", async () => {
    const data = await runCliJson(fakeBinary(), ["search", "lua"]);
    expect(data).toEqual({ args: ["search", "lua", "--json"] });
  });

  test("maps non-zero JSON errors", async () => {
    await expect(runCliJson(fakeBinary(), ["fail"])).rejects.toMatchObject({ name: "MasonCliError", code: "bad", message: "failed" });
  });

  test("rejects invalid stdout JSON", async () => {
    await expect(runCliJson(fakeBinary(), ["invalid"])).rejects.toBeInstanceOf(MasonCliError);
  });

  test("aborts running child processes", async () => {
    const controller = new AbortController();
    const promise = runCliJson(fakeBinary(), ["sleep"], { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });
});
