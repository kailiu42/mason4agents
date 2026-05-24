# mason4agents

**Mason Registry powered tool installer for coding agents.**

mason4agents downloads and manages LSP servers, formatters, linters, and other development tools from the [Mason Registry](https://github.com/mason-org/mason-registry) — the same registry used by mason.nvim. It installs tools to XDG-compliant directories and makes them available via PATH to coding agents such as [Oh My Pi](https://ohmyPi.com).

v1 supports **Pi CLI** (v0.75.5+). Future versions may add Claude Code, Codex CLI, Copilot, OpenCode, and MCP adapters.

## Features

- **Mason Registry compatible** — consumes the same registry, package schema, and release assets as mason.nvim
- **No Neovim dependency** — standalone Rust CLI, no shelling out to Neovim
- **Pi extension** — `/mason` interactive package manager, CLI-equivalent slash subcommands, 7 LLM-callable tools, automatic PATH injection
- **XDG Base Directory** — data, config, cache, and state follow `$XDG_*` conventions
- **Safe by default** — no build script execution without `--allow-build-scripts`, zip-slip protection, path traversal rejection, sandboxed temp directories with atomic rename
- **JSON protocol** — all CLI commands support `--json` for machine-readable output
- **Cross-platform** — Linux, macOS, Windows (Unix symlinks on \*nix, `.cmd` wrappers on Windows)
- **No shell profile modification** — `mason4agents env` outputs `export PATH=...` for manual sourcing

## Prerequisites

- **Rust toolchain** (stable, edition 2021) — for building from source
- **Bun** (v1.x) — for TypeScript Pi adapter
- **Pi CLI** (v0.75.5+) — for Pi extension integration
- **External package managers** (optional, per source type):
  - `npm` — for npm-based packages
  - `python3` + `pip` — for PyPI packages
  - `cargo` — for crates.io packages
  - `go` — for Go packages
  - `gem` — for Ruby packages
  - `composer` — for PHP packages
  - `luarocks` — for Lua packages
  - `nuget` — for NuGet packages

Run `mason4agents doctor` to check which managers are available on your system.

## Installation

### From source

```bash
git clone <repo-url>
cd mason4agents
cargo build --release
# binary at target/release/mason4agents
```

### Via npm / Pi (when published)

```bash
# Install the package (locally or from npm)
pi install npm:mason4agents

# Or test locally without publishing
pi --offline -e dist/pi/extension.js
```

### Binary resolution order

The npm shim and Pi extension locate the Rust binary by checking (in order):

1. `MASON4AGENTS_BIN` environment variable
2. Bundled `native/mason4agents-{platform}-{arch}` (built by `bun run build`)
3. Development `target/debug/mason4agents` (after `cargo build`)

## Quick Start

### CLI

```bash
# Refresh the Mason Registry cache
mason4agents refresh

# Search for packages
mason4agents search lua
mason4agents search --category LSP --language TypeScript

# Install a package
mason4agents install stylua
mason4agents install typescript-language-server

# List installed packages
mason4agents list --installed

# Check which directory a binary was installed to
mason4agents which stylua

# Get shell PATH setup
eval "$(mason4agents env --shell bash)"

# Run diagnostics
mason4agents doctor

# Uninstall
mason4agents uninstall stylua
```

### Pi Extension

Open the interactive package manager in Pi:

```
/mason
```

The panel shows command tabs at the top (`search`, `list`, `installed`, `install`, `uninstall`, `update`, `which`, `refresh`, `doctor`, `env`, `bin-dir`) and a formatted output area below. Table views show installed status directly and support `/` local filtering, `↑`/`↓` scrolling, `e` to edit the active command input, and `l` to edit the `search --language` filter.

Run CLI-equivalent slash subcommands directly when you do not need the panel:

```text
/mason search stylua --language Lua
/mason installed
/mason list --outdated
/mason install stylua
/mason uninstall stylua
/mason doctor
/mason-doctor
```

Direct slash-command results are rendered as human-readable tables or summaries, not raw JSON.

Use the following tools from Pi (they call the Rust CLI under the hood):

| Tool | Description |
|---|---|
| `mason_list` | List installed/outdated packages |
| `mason_search` | Search registry with query, category, language filters |
| `mason_install` | Install one or more packages |
| `mason_uninstall` | Uninstall packages |
| `mason_update` | Update packages (all or specific) |
| `mason_which` | Resolve an installed binary path |
| `mason_env` | Generate shell PATH setup |

### All CLI Commands

```text
mason4agents refresh [--registry <url|file>]
mason4agents search [query] [--category LSP|Formatter|Linter] [--language <lang>]
mason4agents list [--installed|--outdated]
mason4agents install <pkg[@version]>... [--registry <url|file>] [--allow-build-scripts]
mason4agents uninstall <pkg>...
mason4agents update [pkg...] [--registry <url|file>] [--allow-build-scripts]
mason4agents which <executable>
mason4agents bin-dir
mason4agents env --shell bash|zsh|fish|powershell|cmd|json
mason4agents doctor
```

By default, all commands output human-readable text. Add `--json` for structured JSON output wrapped in `{"ok": true, "data": ...}`.

Example text output:

```text
$ mason4agents doctor
mason4agents doctor
  Bin dir:         /home/user/.local/share/mason4agents/bin
  Bin dir exists:  ✓
  Data writable:   ✓
  Registry cache:  1200 packages
  PATH contains:   ✓
  PATH is first:   ✓
  Managers:
    npm           ✓ installed
    cargo         ✓ installed
    ...
  Overall:         ✓ ok

$ mason4agents which stylua
/home/user/.local/share/mason4agents/bin/stylua

$ mason4agents install stylua
 ✓ stylua v2.5.2  bins: stylua

$ mason4agents env --shell bash
export PATH='/home/user/.local/share/mason4agents/bin':"$PATH"
```

## Building the Plugin

The plugin has two components: the **Rust CLI** (core) and the **Pi extension** (TypeScript).

### Build everything (recommended)

```bash
bun run build
```

This runs:
1. `bun build` to bundle the TypeScript npm shim (`dist/bin/mason4agents.js`)
2. `bun build` to bundle the Pi extension (`dist/pi/extension.js`)
3. `cargo build --release` to compile the Rust CLI
4. Copies the release binary to `native/mason4agents-{platform}-{arch}`

### Build components separately

```bash
# Rust CLI only
cargo build --release                          # binary: target/release/mason4agents
cargo build                                    # debug binary: target/debug/mason4agents

# Pi extension only (TypeScript bundle)
./node_modules/.bin/tsc --noEmit               # typecheck
bun build src/pi/extension.ts --outdir dist/pi --target bun
```

### Output artifacts

| Artifact | Path | Used by |
|---|---|---|
| Rust CLI | `target/release/mason4agents` | Direct shell usage |
| Rust CLI (dev) | `target/debug/mason4agents` | Pi extension dev fallback |
| Native binary | `native/mason4agents-{platform}-{arch}` | Bundled Pi extension lookup |
| npm shim | `dist/bin/mason4agents.js` | `npx mason4agents` |
| Pi extension | `dist/pi/extension.js` | `pi --offline -e dist/pi/extension.js` |

## Tests

### Rust

```bash
cargo test                         # 42 tests (40 unit + 2 integration)
cargo test cli_fixture             # CLI integration tests only
cargo test -- --ignored            # including network smoke test
```

### TypeScript

```bash
bun test                           # 19 tests
```

### Full verification

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && ./node_modules/.bin/tsc --noEmit && bun test
```

## XDG Directory Layout

```text
~/.config/mason4agents/              # Configuration
~/.local/share/mason4agents/
  bin/                               # Symlinks to installed tools (on PATH)
  packages/<name>/...                # Installed package contents
  share/                             # Mason share links
  opt/                               # Mason opt links
  state/installed.json               # Install state database
~/.cache/mason4agents/
  registry/                          # Cached registry index + checksum
  downloads/                         # Downloaded archives (cacheable)
  logs/                              # Install logs
~/.local/state/mason4agents/
  locks/                             # Install/update lock files
```

Override any directory via `MASON4AGENTS_CONFIG_HOME`, `MASON4AGENTS_DATA_HOME`, `MASON4AGENTS_CACHE_HOME`, `MASON4AGENTS_STATE_HOME`.

## Unsupported Source Types in v1

The following Mason source types are recognized but require external package managers (`mason4agents doctor` will report them):

- `npm`, `pypi`, `cargo`, `golang`, `gem`, `composer`, `luarocks`, `nuget`

Build scripts (`source.build.run`) are **disabled by default** and require explicit `--allow-build-scripts`.

## What is NOT in v1

- Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode adapters
- MCP server
- Automatic shell profile modification
- Neovim/mason.nvim integration or dependency

## License

Apache-2.0