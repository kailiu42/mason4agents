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
  writeFileSync(bin, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "fail") { console.log(JSON.stringify({ ok: false, error: { code: "bad", message: "failed" } })); process.exit(7); }
if (args[0] === "invalid") { console.log("not json"); process.exit(0); }
if (args[0] === "sleep") { await new Promise((resolve) => setTimeout(resolve, 5000)); }
if (args[0] === "progress") {
  process.stderr.write("{\\"kind\\":\\"progress\\",");
  await new Promise((resolve) => setTimeout(resolve, 1));
  process.stderr.write("\\"schema_version\\":1,\\"operation\\":\\"install\\",\\"phase\\":\\"download\\",\\"status\\":\\"running\\",\\"package\\":\\"lua-language-server\\",\\"message\\":\\"downloaded 512 KiB / 2.0 MiB (25.0%) at 256 KiB/s\\",\\"elapsed_ms\\":4,\\"total_bytes\\":2097152,\\"downloaded_bytes\\":524288,\\"download_percent\\":25,\\"bytes_per_second\\":262144}\\n");
  process.stderr.write("not json\\n");
  process.stderr.write(JSON.stringify({ kind: "progress", schema_version: 1, operation: "install", phase: "package", status: "succeeded", package: "lua-language-server", message: "installed", elapsed_ms: 9 }) + "\\n");
}
console.log(JSON.stringify({ ok: true, data: { args } }));
`);
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

  test("streams structured stderr progress without affecting final result", async () => {
    const events: unknown[] = [];
    const data = await runCliJson(fakeBinary(), ["progress"], { onProgress: (event) => events.push(event) });
    expect(data).toEqual({ args: ["progress", "--json"] });
    expect(events).toEqual([
      {
        kind: "progress",
        schema_version: 1,
        operation: "install",
        phase: "download",
        status: "running",
        package: "lua-language-server",
        message: "downloaded 512 KiB / 2.0 MiB (25.0%) at 256 KiB/s",
        elapsed_ms: 4,
        total_bytes: 2097152,
        downloaded_bytes: 524288,
        download_percent: 25,
        bytes_per_second: 262144,
      },
      {
        kind: "progress",
        schema_version: 1,
        operation: "install",
        phase: "package",
        status: "succeeded",
        package: "lua-language-server",
        message: "installed",
        elapsed_ms: 9,
      },
    ]);
  });
  test("aborts running child processes", async () => {
    const controller = new AbortController();
    const promise = runCliJson(fakeBinary(), ["sleep"], { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });
});
