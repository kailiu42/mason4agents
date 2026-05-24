# Repository Guidelines

## Project Overview

**mason4agents** — a Mason Registry powered tool installer for coding agents. Downloads and manages LSP servers, formatters, linters, and other development tools from the Mason Registry (mason.nvim ecosystem), installing them to XDG directories and making them available via PATH to agents like Oh My Pi (Pi CLI, v0.75.5).

v1 implements: Pi extension (tools, `/mason` panel), Rust CLI/installer, XDG paths, safe archive extraction, multi-source installers. Non-goals for v1: Claude Code/Codex/Copilot/OpenCode adapters, MCP server, shell profile modification.

## Architecture & Data Flow

```
CLI (Rust binary `mason4agents`)  ←→  Pi adapter (TypeScript/Bun)
       │                                      │
       │  JSON envelope over stdio            │  child_process.spawn
       │  {"ok":true,"data":...}              │  always appends --json
       │  {"ok":false,"error":{...}}          │
       └────────── mason4agents core ─────────────┘
                        │
          ┌───────┬─────┼─────┬────────┐
          │       │     │     │        │
      registry  normalize  download  unpack  link/install
```

### Data Flow

1. **Registry refresh**: Fetch Mason Registry ZIP (default URL: `https://github.com/mason-org/mason-registry/archive/refs/heads/main.zip`) or load from local directory/file → parse `package.yaml` files → serialize as JSON cache with SHA-256 checksum
2. **Normalize**: Load raw YAML → select platform-specific version override (narrowest constraint wins) → select platform target asset (YAML order, first match, string or array targets) → render `{{expression}}` templates → resolve bin/share/opt specs
3. **Download**: Fetch archive/binary to cache (`<cache>/downloads/<hash>/<filename>`), strip URL query/fragment for clean filename
4. **Unpack**: Extract zip/tar/tgz/gz/vsix with optional strip-prefix; reject symlinks, hardlinks, path traversal, absolute paths, duplicate entries
5. **Install**: Temp dir → atomic rename → create symlinks in `bin/` (Unix) or `.cmd` wrappers (Windows) → record state → rollback on failure

### Rust Modules

| Module | Responsibility |
|---|---|
| `main.rs` | CLI entrypoint, clap subcommands, `try_parse` + JSON error envelope |
| `types.rs` | `M4aError` enum, `Result<T>`, `success_json()` / `error_json()` envelope helpers |
| `paths.rs` | XDG directory resolution (`MasonPaths::from_env`), `env_or_xdg` with absolute-path check, Windows `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` fallback |
| `platform.rs` | Platform detection (os/arch/libc), target candidate order, `select()` for best match |
| `purl.rs` | PURL parser (`pkg:type/ns/name@version?qualifiers#subpath`), supports `pkg://`, percent-decoding |
| `expressions.rs` | `{{variable.path}}` and `{{ value \| strip_prefix "v" }}` template rendering against a JSON context |
| `registry.rs` | Registry fetch/refresh/cache/checksum, search with query/category/language filters |
| `package_spec.rs` | Mason `package.yaml` parsing, normalization, asset/download/build selection, version overrides, deprecation, supported_platforms |
| `installer.rs` | Orchestration: install/update/uninstall, state lock, package lock, atomic rename, rollback, link recreation |
| `installers/manager.rs` | Package-manager commands: npm/pypi/cargo/golang/gem/composer/luarocks/nuget |
| `installers/github.rs` | GitHub release asset URL construction |
| `installers/generic.rs` | Generic download locator resolution |
| `installers/openvsx.rs` | OpenVSX vsix URL construction |
| `installers/build.rs` | Build script execution (gated by `--allow-build-scripts`) |
| `archive.rs` | `split_archive_spec`, `unpack_or_copy`, `unpack_zip/tar/tgz/gz`, zip-slip/traversal/symlink rejection |
| `download.rs` | `download_to_cache` (digest-hashed cache dir), `fetch_bytes` (HTTP with retries), local path detection |
| `linker.rs` | Unix symlink, Windows `.cmd` wrapper, share/opt links, link ownership validation, cleanup with target verification |
| `locks.rs` | `PackageLock` (exclusive file lock via `fs2`) |
| `store.rs` | `InstalledState` JSON persistence, atomic write via temp-file + rename |
| `doctor.rs` | Diagnostic report: paths, registry cache, PATH, external managers, writability |

### CLI Subcommands

| Command | Description |
|---|---|
| `refresh [--registry <url\|file>]` | Fetch and cache registry |
| `search [query] [--category] [--language] [--registry]` | Search cached registry |
| `list [--installed\|--outdated] [--registry]` | List packages |
| `install <pkg[@version]>... [--registry] [--allow-build-scripts]` | Install packages |
| `uninstall <pkg>...` | Uninstall packages |
| `update [pkg...] [--registry] [--allow-build-scripts]` | Update packages (all or specified) |
| `which <executable>` | Locate installed executable |
| `bin-dir` | Print bin directory path |
| `env --shell bash\|zsh\|fish\|powershell\|cmd\|json` | Generate shell PATH setup |
| `doctor` | Run diagnostics |

By default, commands output human-readable text. Add `--json` for machine-readable JSON output (all results wrapped in `{"ok":true,"data":...}`). Parse errors produce `{"ok":false,"error":{"code":"parse_error","message":"clap: ..."}}`; help/version go to stderr with exit code 0.

## Key Directories

| Path | Purpose |
|---|---|
| `crates/mason4agents/src/` | Rust core library + CLI binary |
| `crates/mason4agents/tests/` | Rust integration tests |
| `src/pi/` | TypeScript Pi extension (adapter, panel, tools, bridge) |
| `src/bin/` | npm bin shim (forwards to Rust binary) |
| `test/pi/` | TypeScript tests for Pi adapter |
| `test/fixtures/registry/` | Test registry `package.yaml` fixtures |
| `native/` | Built Rust binary named `mason4agents-{platform}-{arch}` (gitignored) |

## Development Commands

```bash
# Rust
cargo build                          # debug build
cargo build --release                # release build
cargo test                           # 42 tests (40 unit + 2 integration)
cargo fmt                            # format Rust code
cargo clippy --all-targets -- -D warnings  # lint

# TypeScript
./node_modules/.bin/tsc --noEmit     # typecheck (or bun run typecheck after bun install)
bun test                             # 13 tests

# Build everything
bun run build                        # bundle TS + cargo build --release + copy to native/

# Full verification
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && ./node_modules/.bin/tsc --noEmit && bun test
```

## Code Conventions & Common Patterns

### Rust

- **Error handling**: `thiserror` + `M4aError` enum. Use `crate::types::msg("...")` for string errors, `M4aError::Io(io::Error)` for conversions. All public functions return `Result<T, M4aError>`.
- **JSON protocol**: Use `success_json(data)` / `error_json(&err)` to build envelope. CLI `main()` prints serialized JSON to stdout. Stderr for logs/progress. Never print non-JSON to stdout in `--json` mode.
- **Path validation**: `validate_package_name()` rejects `/`, `\`, `:`, `.`, `..`, empty names. Used for package names, link names (bin/share/opt keys), and executable names.
- **Path containment**: `path_is_within(path, base)` checks via canonicalize (when both exist) or manual `..` resolution. Used for link targets and archive entries.
- **Lock ordering**: Global state lock (`_state`) acquired first, then per-package lock (`PackageLock::acquire(paths, name)`). Drop in reverse. Prevents deadlock and concurrent state corruption.
- **Atomic install**: Download/unpack to `package_tmp_dir` → rename to `package_dir`. Old `package_old_dir` kept for rollback. On link-creation failure, roll back package dir and recreate previous links.
- **Archive handling**: `split_archive_spec("file.zip:prefix/")` returns (filename, optional strip_prefix). Dispatch via `unpack_or_copy()`. Supported: zip, tar, tar.gz, tgz, gz, vsix. Symlinks/hardlinks rejected. Path traversal rejected. Duplicate entries rejected.
- **Expressions**: `{{version}}`, `{{source.asset.bin}}`, `{{ source.asset.file }}`, `{{ version | strip_prefix "v" }}`. Only `strip_prefix` filter allowed. Context includes `version`, `source.id`, `source.asset.*` (all rendered fields promoted to top level, not nested under `extra`).
- **PURL parsing**: `pkg:type/ns/name@version?qualifiers#subpath`. Supports `pkg://` prefix. Percent-decodes type, namespace, name, version, subpath, qualifiers.
- **Platform targets**: Candidate order: `linux_x64_gnu` → `linux_x64` → `linux` → `unix` (and similar for darwin/win). Selected via `Platform::select()` which checks each candidate against a map.
- **Asset selection**: Iterate YAML sequence in order, accept `target` as string or array of strings, return first match. Not BTreeMap-based (preserves Mason registry order).
- **Build scripts**: Platform-specific `build.run` entries (with `target` fields) are selected by platform. Gated by `--allow-build-scripts`. Default: rejected with clear error.
- **Deprecation**: Mason's `deprecation` field is an object; custom serde deserializer accepts bool, object, or absent — all treated as boolean.
- **Inline tests**: `#[cfg(test)] mod tests { ... }` in every module. Use `tempfile::tempdir()` for filesystem tests. Target 40+ unit tests.

### TypeScript

- **Binary resolver** (in order): `MASON4AGENTS_BIN` env var → bundled `native/mason4agents-{process.platform}-{process.arch}` (with `.exe` on Windows, `{platform}` is Node's native name like `win32`, `darwin`, `linux`) → cargo `target/debug/mason4agents`. Checks `statSync().isFile()` + `accessSync(path, X_OK)` (non-Windows) before accepting.
- **CLI bridge**: `createCliBridge()` returns `{ run(args, options?: { signal? }) }`. Always appends `--json`. On non-zero exit with empty/invalid stdout, falls back to `command_failed` instead of `invalid_json`. Checks `signal.aborted` before spawning.
- **PATH injection**: `ensureMasonBinOnPath()` prepends `<data-dir>/bin` to `process.env.PATH`. Idempotent. Distinguishes undefined PATH (sets directly) from empty string `""` (preserves empty segment).
- **PATH data-dir**: Mirrors Rust `MasonPaths::from_env`. Checks `MASON4AGENTS_DATA_HOME` (absolute only), then `XDG_DATA_HOME` or `LOCALAPPDATA` (absolute only), then `$HOME/.local/share`. Relative values fall back to defaults.
- **Extension API compatibility**: Tries `ctx.registerTool`, `ctx.tools?.registerTool`, `ctx.tools?.register`. Tries `ctx.registerCommand`, `ctx.commands?.registerCommand`, `ctx.commands?.register`, `ctx.command?.register`. Tries `ctx.on`, `ctx.events?.on`.
- **TypeBox schemas**: Tool parameters use `Type.Object({ field: Type.Optional(Type.String()) })`. Every optional field MUST be wrapped in `Type.Optional()` — otherwise Pi's schema validator rejects calls missing that field.
- **Tool definition shape**:
  ```ts
  {
    name: string,             // mason_list, mason_install, etc.
    label: string,            // human-readable
    description: string,
    promptSnippet: string,
    parameters: Type.Object({ ... }),
    execute(toolCallId: string, params: unknown, signal?: AbortSignal):
      Promise<{ content: [{ type: "text", text: string }], details: unknown }>
  }
  ```
- **7 registered tools**: `mason_list`, `mason_search`, `mason_install`, `mason_uninstall`, `mason_update`, `mason_which`, `mason_env`.
- **2 slash commands**: `/mason` (opens package panel via `ctx.ui.custom`), `/mason-doctor` (runs doctor and displays via `ctx.sendMessage`).
- **Signal forwarding**: `src/bin/mason4agents.ts` shim removes SIGINT/SIGTERM listeners before re-raising the child's signal, preventing loops.

## Important Files

| File | Role |
|---|---|
| `crates/mason4agents/src/main.rs` | CLI entrypoint, clap subcommands, JSON envelope routing |
| `crates/mason4agents/src/lib.rs` | Crate root, re-exports `M4aError` and `Result` |
| `crates/mason4agents/src/types.rs` | Error types, JSON envelope helpers |
| `crates/mason4agents/src/paths.rs` | XDG directory resolution |
| `crates/mason4agents/src/platform.rs` | Platform detection and target matching |
| `crates/mason4agents/src/purl.rs` | PURL parser |
| `crates/mason4agents/src/package_spec.rs` | Mason YAML parsing, normalization, expressions |
| `crates/mason4agents/src/registry.rs` | Registry refresh, cache, search |
| `crates/mason4agents/src/installer.rs` | Install/uninstall/update orchestration |
| `crates/mason4agents/src/archive.rs` | Archive extraction with safety checks |
| `crates/mason4agents/src/download.rs` | HTTP download and cache |
| `crates/mason4agents/src/linker.rs` | Symlink/wrapper management |
| `crates/mason4agents/src/locks.rs` | File-based package locks |
| `crates/mason4agents/src/store.rs` | Installed state persistence |
| `crates/mason4agents/src/doctor.rs` | System diagnostics |
| `crates/mason4agents/src/installers/manager.rs` | Package-manager installer commands |
| `src/pi/extension.ts` | Pi extension activation entrypoint |
| `src/pi/pi-tools.ts` | Tool definitions (TypeBox schemas + executors) |
| `src/pi/cli.ts` | Rust binary invocation bridge |
| `src/pi/binary.ts` | Binary resolver with platform naming |
| `src/pi/path-env.ts` | PATH injection (mirrors Rust path resolution) |
| `src/pi/mason-panel.ts` | `/mason` panel state/UI |
| `src/bin/mason4agents.ts` | npm `mason4agents` CLI shim |
| `package.json` | npm/Pi package metadata, build scripts |
| `Cargo.toml` | Rust workspace root |

## Runtime/Tooling Preferences

- **Rust**: stable toolchain, edition 2021, resolver = "2". Features: `reqwest` (blocking + rustls-tls), `zip` (deflate + deflate64), `chrono/serde`, `clap/derive`.
- **TypeScript**: Bun runtime (v1.3.14). `tsc --noEmit` for typecheck.
- **Package manager**: Bun.
- **Linting**: `cargo clippy --all-targets -- -D warnings`. No clippy.toml. No TS linter.
- **Formatting**: `cargo fmt` for Rust. TS follows existing style (no formatter).
- **Testing**: `cargo test` (Rust), `bun test` (TypeScript).
- **No CI config**: currently none.
- **Native binary**: `bun run build` runs `cargo build --release` and copies to `native/mason4agents-{platform}-{arch}` (with `.exe` on Windows).
- **No shell profile modification**: `mason4agents env` outputs shell snippets for manual sourcing.
- **Pi v0.75.5**: Extension loaded via `pi --offline -e dist/pi/extension.js` or `pi install npm:<package>`.

## Testing & QA

### Rust Tests (42 total)

- **Unit tests**: Inline `#[cfg(test)] mod tests` in every module. Coverage areas:
  - XDG path resolution (explicit/XDG/fallback/override)
  - PURL parser (npm, scoped npm, github, generic, pypi, cargo, golang, openvsx, qualifiers, subpath, `pkg://`, invalid)
  - Platform detection/target matching (precedence, fallback, unsupported)
  - Registry client (file registry, zip, JSON cache, checksum, corruption)
  - Package spec normalization (expressions, version override, unsupported target, build scripts)
  - Expression parser (`{{version}}`, `{{source.asset.bin}}`, `strip_prefix`, unknown var/filter)
  - Archive safety (zip/tar/tgz/gz, traversal, symlink, duplicate, strip-prefix)
  - Linker (Unix symlink, Windows wrapper, share/opt, cleanup, bin scheme resolution)
  - Installer state/locks (atomic commit, rollback, concurrent locks, build-script gating, missing-manager error)
  - Doctor (paths, managers, missing registry)
- **Integration tests** (2): Full CLI flow with fixture registry (refresh → search → install → which → env → doctor → uninstall), stable JSON error shape
- **Network smoke test** (1, `#[ignore]`): Real Mason Registry: refresh and search known packages (typescript-language-server, lua-language-server, rust-analyzer, stylua)
- **Fixtures**: `test/fixtures/registry/packages/fixture/package.yaml`
- **Key patterns**: `tempfile::tempdir()` for filesystem isolation, `assert_cmd::Command` for CLI tests, `serde_json::from_slice` for JSON parsing

### TypeScript Tests (13)

- **Framework**: Bun's built-in test runner
- **Location**: `test/pi/` — one file per module
- **Test files**:
  - `binary-path.test.ts`: binary resolver env/bundled/dev fallback, PATH injection idempotency, XDG/explicit override resolution
  - `cli-bridge.test.ts`: `--json` auto-append, error envelope parsing, invalid JSON, abort signal
  - `pi-tools.test.ts`: schema shapes, argv mapping, input validation
  - `panel-extension.test.ts`: panel search/install/uninstall/update/doctor, extension activation (commands, tools, session_start, PATH)
- **Key patterns**: Fake `CliBridge` implementations (no spawning), `tempdir` + temp env mutations, `afterEach` cleanup
- **No mocking libraries**: Prefer fake implementations

### Running Tests

```bash
cargo test                                       # 42 Rust tests
cargo test cli_fixture                           # CLI integration tests only
cargo test -- --ignored                          # including network smoke
cargo test real_mason_registry_refreshes_and_searches_known_packages -- --ignored
bun test                                         # 13 TypeScript tests
```

### Coverage Expectations

- New Rust modules MUST include inline unit tests for error paths, edge cases, and happy paths.
- New CLI subcommands MUST have integration tests in `tests/cli_fixture.rs`.
- New TS modules MUST have `test/pi/<module>.test.ts` with fake bridge coverage.
- Network-dependent tests MUST be `#[ignore]` with a clear doc comment.

## README Maintenance

- `README.md` (English) and `README.zh.md` (Chinese) must be kept in sync.
- When updating either file, always update the other with equivalent content in the other language.
- The only difference between them is the language; structure, commands, paths, version numbers, and links must be identical.
- Both files live at the project root.