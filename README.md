# mason4agents

> TL;DR: if you have ever used [mason.nvim](https://github.com/mason-org/mason.nvim), this is it for coding agents.

**Mason Registry powered tool installer for coding agents.**

mason4agents downloads and manages LSP servers, formatters, linters, and other development tools from the [Mason Registry](https://github.com/mason-org/mason-registry) — the same registry used by mason.nvim. It installs tools into the user's home directory and makes them available via PATH to coding agents such as [oh-my-pi](https://github.com/can1357/oh-my-pi).

It currently supports **oh-my-pi**. Future versions may support Claude Code, Codex CLI, Copilot, OpenCode, and others.

## Why

Installing tools such as LSP servers, linters, and formatters is inconvenient. Many of them are not included in native OS package managers, so users have to download and install them manually. This introduces maintenance burden.

Another problem is you may not know what tools are available for your project. This tool includes a (primitive) suggestion function. It scans your project, prefers oh-my-pi's built-in LSP defaults, and falls back to information from [LazyVim](https://github.com/LazyVim/LazyVim) to suggest relevant tools.

## Features

- **Mason Registry compatible** — consumes the same registry, package schema, and release assets as mason.nvim
- **OMP/Pi extension** — `/mason` interactive package manager, CLI-backed slash subcommands, 7 LLM-callable tools, automatic PATH injection
- **XDG Base Directory** — data, config, cache, and state follow `$XDG_*` conventions
- **Safe by default** — no build script execution without `--allow-build-scripts`, zip-slip protection, path traversal rejection, sandboxed temp directories with atomic rename
- **JSON protocol** — all CLI commands support `--json` final envelopes; long operations stream stderr NDJSON progress with byte totals, percent complete, and current speed when available
- **Cross-platform** — Linux, macOS, Windows (Unix symlinks on \*nix, `.cmd` wrappers on Windows)
- **No shell profile modification** — `mason4agents env` outputs `export PATH=...` for manual sourcing

## Prerequisites

- **Rust toolchain** (stable, edition 2021) — for building from source
- **Bun** (v1.x) — for the TypeScript OMP/Pi adapter
- **oh-my-pi (OMP) or Pi CLI** — for extension integration
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

### Via npm package in oh-my-pi (OMP) / Pi

```bash
# Install with oh-my-pi (OMP)
omp plugin install mason4agents

# Or install with Pi
pi install npm:mason4agents

# Test locally with OMP without publishing
omp --extension ./dist/pi/extension.js
# or
pi --offline -e dist/pi/extension.js
```

### Binary resolution order

The npm shim and OMP/Pi extension locate the Rust binary by checking (in order):

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

Open the interactive package manager in OMP/Pi:

```
/mason
```

The panel opens as a host-width, theme-aware TUI with visible tabs at the top (`list`, `suggested`, `installed`, `check update`, `refresh`, `doctor`) and a width-aware table area below. The `suggested` tab scans the local project, prefers OMP built-in LSP defaults as its LSP recommendation source, and falls back to locally cached LazyVim curated suggestions for languages OMP does not cover. Table views show installed status directly, keep a highlighted current row, and support `Tab`/`←`/`→` to switch tabs, `/` local filtering, `↑`/`↓` row selection, `Enter` for an in-place package detail popup, and state-aware package actions: `i` for missing packages, `u`/`d` for installed packages. Long operations (`install`, `update`, `uninstall`, `refresh`) show a modal progress panel, block additional Mason operations while the CLI runs, enter a 30s no-progress warning state where `q`/`Esc` closes the panel without killing the CLI, and keep the final result in that panel.

Run CLI-backed slash subcommands directly when you do not need the panel. `/mason` with no arguments opens the TUI; pressing `Tab` after the bare `/mason ` prompt shows all subcommands, and typing a prefix narrows the subcommand suggestions with per-command argument shapes before you press Enter:

```text
/mason search stylua --language Lua
/mason installed
/mason list --outdated
/mason install stylua
/mason uninstall stylua
/mason doctor
/mason register --omp
```

Direct non-long slash-command results are rendered as human-readable tables or summaries, not raw JSON. Direct long commands (`/mason install`, `/mason update`, `/mason uninstall`, `/mason refresh`) use the same progress panel when custom UI is available and fall back to the final rendered result otherwise.

Use the following tools from OMP/Pi (they call the Rust CLI under the hood):

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
mason4agents search [query] [--category <category>] [--language <lang>] [--registry <url|file>]
mason4agents list [--installed|--outdated] [--registry <url|file>]
mason4agents install <pkg[@version]>... [--registry <url|file>] [--allow-build-scripts]
mason4agents uninstall <pkg>...
mason4agents update [pkg...] [--registry <url|file>] [--allow-build-scripts]
mason4agents which <executable>
mason4agents bin-dir
mason4agents env --shell bash|zsh|fish|powershell|cmd|json
mason4agents doctor
mason4agents register --omp
```

By default, all commands output human-readable text. Add `--json` for a final structured JSON envelope wrapped in `{"ok": true, "data": ...}`; for long operations, progress events are written to stderr as NDJSON objects with `kind: "progress"` while stdout remains the final envelope only. Download progress events include `total_bytes`, `downloaded_bytes`, `download_percent`, and `bytes_per_second` when the remote source reports a content length.
Package-changing commands run through the OMP/Pi extension or npm CLI refresh OMP LSP registration after successful installs, updates, and uninstalls. Run `mason4agents register --omp` to register already-installed Mason LSP tools with oh-my-pi manually.

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

## Building

The package has three delivered pieces: the **Rust CLI** (core), the **npm shim**, and the **OMP/Pi extension** (TypeScript).

### Build everything (recommended)

```bash
bun run build
```

This runs:
1. `bun build` to bundle the TypeScript npm shim (`dist/bin/mason4agents.js`)
2. `bun build` to bundle the OMP/Pi extension (`dist/pi/extension.js`)
3. `cargo build --release` to compile the Rust CLI
4. Copies the release binary to `native/mason4agents-{platform}-{arch}`

### Build components separately

```bash
# Rust CLI only
cargo build --release                          # binary: target/release/mason4agents
cargo build                                    # debug binary: target/debug/mason4agents

# OMP/Pi extension only (TypeScript bundle)
./node_modules/.bin/tsc --noEmit               # typecheck
bun build src/pi/extension.ts --outdir dist/pi --target bun
```

### Output artifacts

| Artifact | Path | Used by |
|---|---|---|
| Rust CLI | `target/release/mason4agents` | Direct shell usage |
| Rust CLI (dev) | `target/debug/mason4agents` | OMP/Pi extension dev fallback |
| Native binary | `native/mason4agents-{platform}-{arch}` | Bundled OMP/Pi extension lookup |
| npm shim | `dist/bin/mason4agents.js` | `npx mason4agents` |
| OMP/Pi extension | `dist/pi/extension.js` | `omp --extension ./dist/pi/extension.js` / `pi --offline -e dist/pi/extension.js` |

### Package and publish the current platform

```bash
# Build a local tarball for install testing
bun run publish:local

# Alias for the same local tarball flow
bun run pack:local

# Real npm publish
bun run publish:npm
```

These commands package the current platform binary as `native/mason4agents-{platform}-{arch}`. For a multi-platform npm package, add the other `native/mason4agents-*` binaries before running the publish command.

## Tests

### Rust

```bash
cargo test                         # Rust test suite
cargo test cli_fixture             # CLI integration tests only
cargo test -- --ignored            # including network smoke test
```

### TypeScript

```bash
bun test                           # TypeScript test suite
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
~/.cache/mason4agents/
  registry/                          # Cached registry index + checksum
  downloads/                         # Downloaded archives (cacheable)
  logs/                              # Install logs
~/.local/state/mason4agents/
  installed.json                     # Install state database
  locks/                             # Install/update lock files
```

Override any directory via `MASON4AGENTS_CONFIG_HOME`, `MASON4AGENTS_DATA_HOME`, `MASON4AGENTS_CACHE_HOME`, `MASON4AGENTS_STATE_HOME`.

## Source Types Requiring External Managers

The following Mason source types are installed via external package managers (`mason4agents doctor` reports their availability):

- `npm`, `pypi`, `cargo`, `golang`, `gem`, `composer`, `luarocks`, `nuget`

Build scripts (`source.build.run`) are **disabled by default** and require explicit `--allow-build-scripts`.

## What is NOT currently included

- Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode adapters
- Automatic shell profile modification
- Neovim/mason.nvim integration or dependency

## License

MIT
