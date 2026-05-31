# Repository Guidelines

## Project Snapshot

`mason4agents` is a Mason Registry-backed installer for coding agents. It has a
Rust CLI/core and a TypeScript/Bun Pi extension that shells out to the CLI.

Core flow: refresh registry -> normalize package spec -> download -> unpack ->
install/link. Keep v1 focused on the Rust CLI, Pi tools/panel, XDG paths, safe
archive extraction, and supported installers. Do not add shell profile mutation,
MCP, or non-Pi agent adapters unless explicitly requested.

## Key Paths

| Path | Purpose |
| --- | --- |
| `crates/mason4agents/src/` | Rust core library and CLI |
| `crates/mason4agents/tests/` | Rust integration tests |
| `src/pi/` | Pi extension, tools, panel, CLI bridge |
| `src/bin/` | npm CLI shim |
| `test/pi/` | TypeScript tests |
| `test/fixtures/registry/` | Registry fixtures |
| `native/` | Built Rust binaries, gitignored |

## Commands

Prefix shell commands with `rtk`.

```bash
rtk cargo fmt --check
rtk cargo clippy --all-targets -- -D warnings
rtk cargo test
rtk ./node_modules/.bin/tsc --noEmit
rtk bun test
rtk bun run build
```

Run the smallest relevant verification during edits. For broad changes, run the
full Rust and TypeScript checks above.

## Rust Rules

- Public fallible functions return `crate::types::Result<T>` / `M4aError`.
- In `--json` mode, stdout must contain only the JSON envelope from
  `success_json()` or `error_json()`. Send logs and progress to stderr.
- Validate package, executable, and link names with the existing validation
  helpers before using them in paths.
- Preserve archive safety: reject absolute paths, traversal, symlinks,
  hardlinks, duplicate entries, and unsafe strip-prefix behavior.
- Preserve install safety: acquire the global state lock before package locks,
  install into a temp dir, atomically rename, and roll back links/state on
  failure.
- Keep platform and asset selection compatible with Mason registry semantics:
  narrowest platform match wins, asset YAML order is significant, and `target`
  may be a string or array.
- Expression rendering supports known context fields and the `strip_prefix`
  filter only.
- Build scripts stay gated behind `--allow-build-scripts`.
- Add or update inline unit tests for new Rust behavior and integration tests
  for new CLI surface.

## TypeScript/Pi Rules

- Binary resolution order is: `MASON4AGENTS_BIN`, bundled `native/` binary, then
  Cargo debug binary. Keep executable checks platform-aware.
- `createCliBridge()` always appends `--json`, forwards abort signals, and maps
  empty or invalid stdout on failure to `command_failed` rather than
  `invalid_json`.
- PATH injection must mirror Rust XDG/data-dir resolution and remain
  idempotent. Preserve the difference between undefined PATH and an empty PATH.
- TypeBox optional parameters must use `Type.Optional(...)`; Pi rejects missing
  fields otherwise.
- Keep registered tool and slash-command APIs compatible with the existing Pi
  context fallbacks in `src/pi/extension.ts`.
- Add or update Bun tests with fake bridges for new Pi behavior.

## Docs

Keep `README.md` and `README.zh.md` structurally equivalent. When one changes,
update the other with matching commands, paths, versions, and links.

Keep `docs/recap.md` organized by topic, not by session. When adding or
updating recap content, place entries under exactly these three top-level
headings: `Problems & Solutions`, `Valuable Findings`, and `Things To Avoid`.
Merge related or repeated lessons into the existing bullets instead of adding a
new session section.
