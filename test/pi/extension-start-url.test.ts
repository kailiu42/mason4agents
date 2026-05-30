import { describe, expect, test } from "bun:test";

import { extensionStartUrl } from "../../src/pi/extension";

function ctx(resolvedPath: string) {
  return {
    extension: { resolvedPath },
  };
}

describe("activate extension path handling", () => {
  test("converts Windows absolute extension paths to file URLs", () => {
    expect(extensionStartUrl(ctx("C:\\tmp\\extension.js"))).toBe("file:///C:/tmp/extension.js");
  });

  test("converts POSIX extension paths to file URLs", () => {
    expect(extensionStartUrl(ctx("/tmp/extension.js"))).toBe("file:///tmp/extension.js");
  });

  test("keeps file URLs unchanged", () => {
    expect(extensionStartUrl(ctx("file:///tmp/extension.js"))).toBe("file:///tmp/extension.js");
  });
});
