import { beforeEach, describe, expect, mock, test } from "bun:test";

const startUrls: string[] = [];

mock.module("../../src/pi/cli", () => ({
  createCliBridge(_binary?: string, startUrl?: string) {
    startUrls.push(startUrl ?? "");
    return {
      async run() {
        return {};
      },
    };
  },
}));

mock.module("../../src/pi/path-env", () => ({
  ensureMasonBinOnPath() {
    return { binDir: "/tmp/bin" };
  },
}));

mock.module("../../src/pi/lsp-config", () => ({
  syncMasonLspConfig() {},
}));

mock.module("../../src/pi/omp-lsp-defaults", () => ({
  syncOmpLspDefaultsCache() {},
}));

mock.module("../../src/pi/pi-tools", () => ({
  registerPiTools() {
    return [];
  },
}));

const { activate } = await import("../../src/pi/extension");

function ctx(resolvedPath: string) {
  return {
    extension: { resolvedPath },
    commands: {
      registerCommand() {},
    },
    tools: {
      registerTool() {},
    },
    events: {
      on() {},
    },
  };
}

describe("activate extension path handling", () => {
  beforeEach(() => {
    startUrls.length = 0;
  });

  test("converts Windows absolute extension paths to file URLs", async () => {
    await activate(ctx("C:\\tmp\\extension.js"));
    expect(startUrls).toEqual(["file:///C:/tmp/extension.js"]);
  });

  test("converts POSIX extension paths to file URLs", async () => {
    await activate(ctx("/tmp/extension.js"));
    expect(startUrls).toEqual(["file:///tmp/extension.js"]);
  });

  test("keeps file URLs unchanged", async () => {
    await activate(ctx("file:///tmp/extension.js"));
    expect(startUrls).toEqual(["file:///tmp/extension.js"]);
  });
});
