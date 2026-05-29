import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

describe("release workflow", () => {
  test("checks version sync before release quality gates continue", () => {
    const installDepsIndex = releaseWorkflow.indexOf("- name: Install JS dependencies");
    const versionSyncIndex = releaseWorkflow.indexOf("- name: Check version sync");
    const rustFormatIndex = releaseWorkflow.indexOf("- name: Rust format");

    expect(versionSyncIndex).toBeGreaterThan(installDepsIndex);
    expect(rustFormatIndex).toBeGreaterThan(versionSyncIndex);
    expect(releaseWorkflow).toContain("run: bun run check:version");
  });
});
