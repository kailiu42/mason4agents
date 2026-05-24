# mason4agents

**基于 Mason Registry 的 coding agent 工具安装器。**

mason4agents 从 [Mason Registry](https://github.com/mason-org/mason-registry)（与 mason.nvim 使用同一 registry）下载和管理 LSP server、formatter、linter 等开发工具。工具安装到符合 XDG 规范的目录，并通过 PATH 注入使 coding agent（如 [Oh My Pi](https://ohmyPi.com)）可直接调用。

v1 支持 **Pi CLI**（v0.75.5+）。后续版本可能增加 Claude Code、Codex CLI、Copilot、OpenCode 及 MCP 适配。

## 功能

- **Mason Registry 兼容** — 使用与 mason.nvim 相同的 registry、包 schema 和 release assets
- **不依赖 Neovim** — 独立 Rust CLI，无需 shell out 到 Neovim
- **Pi 扩展** — `/mason` 包管理 UI、7 个 LLM 可调用工具、自动 PATH 注入
- **XDG Base Directory** — data、config、cache、state 遵循 `$XDG_*` 规范
- **默认安全** — 无 `--allow-build-scripts` 不执行构建脚本、zip-slip 防护、路径穿越拒绝、临时目录原子重命名
- **JSON 协议** — 所有 CLI 命令支持 `--json` 机器可读输出
- **跨平台** — Linux、macOS、Windows（\*nix 用符号链接，Windows 用 `.cmd` wrapper）
- **不修改 shell profile** — `mason4agents env` 输出 `export PATH=...`，用户自行 sourcing

## 前置依赖

- **Rust 工具链**（stable，edition 2021）— 从源码构建
- **Bun**（v1.x）— TypeScript Pi adapter
- **Pi CLI**（v0.75.5+）— Pi 扩展集成
- **外部包管理器**（按 source 类型可选）：
  - `npm` — npm 源包
  - `python3` + `pip` — PyPI 源包
  - `cargo` — crates.io 源包
  - `go` — Go 源包
  - `gem` — Ruby 源包
  - `composer` — PHP 源包
  - `luarocks` — Lua 源包
  - `nuget` — NuGet 源包

运行 `mason4agents doctor` 检查系统中可用的管理器。

## 安装

### 从源码构建

```bash
git clone <repo-url>
cd mason4agents
cargo build --release
# 二进制文件位于 target/release/mason4agents
```

### 通过 npm / Pi 安装（发布后）

```bash
# 安装包（从 npm 或本地）
pi install npm:mason4agents

# 本地测试
pi --offline -e dist/pi/extension.js
```

### 二进制文件查找顺序

npm shim 和 Pi 扩展按以下顺序定位 Rust 二进制文件：

1. `MASON4AGENTS_BIN` 环境变量
2. 内置的 `native/mason4agents-{platform}-{arch}`（由 `bun run build` 构建）
3. 开发目录 `target/debug/mason4agents`（`cargo build` 后）

## 快速开始

### CLI

```bash
# 刷新 Mason Registry 缓存
mason4agents refresh

# 搜索包
mason4agents search lua
mason4agents search --category LSP --language TypeScript

# 安装包
mason4agents install stylua
mason4agents install typescript-language-server

# 列出已安装的包
mason4agents list --installed

# 查看二进制安装位置
mason4agents which stylua

# 获取 shell PATH 设置
eval "$(mason4agents env --shell bash)"

# 运行诊断
mason4agents doctor

# 卸载
mason4agents uninstall stylua
```

### Pi 扩展

在 Pi 中打开包管理 UI：

```
/mason
```

运行诊断：

```
/mason-doctor
```

Pi 中可使用以下工具（底层调用 Rust CLI）：

| 工具 | 说明 |
|---|---|
| `mason_list` | 列出已安装/过期的包 |
| `mason_search` | 搜索 registry（支持 query、category、language 过滤） |
| `mason_install` | 安装一个或多个包 |
| `mason_uninstall` | 卸载包 |
| `mason_update` | 更新包（全部或指定） |
| `mason_which` | 查找已安装的二进制路径 |
| `mason_env` | 生成 shell PATH 设置 |

### 全部 CLI 命令

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

默认情况下，所有命令输出人类可读文本。添加 `--json` 可获取结构化的 JSON 输出，包裹在 `{"ok": true, "data": ...}` 中。

示例文本输出：

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

## XDG 目录布局

```text
~/.config/mason4agents/              # 配置文件
~/.local/share/mason4agents/
  bin/                               # 已安装工具的符号链接（在 PATH 中）
  packages/<name>/...                # 已安装包的内容
  share/                             # Mason share 链接
  opt/                               # Mason opt 链接
  state/installed.json               # 安装状态数据库
~/.cache/mason4agents/
  registry/                          # Registry 缓存 + 校验和
  downloads/                         # 下载的归档文件（可清理）
  logs/                              # 安装日志
~/.local/state/mason4agents/
  locks/                             # 安装/更新锁文件
```

可通过 `MASON4AGENTS_CONFIG_HOME`、`MASON4AGENTS_DATA_HOME`、`MASON4AGENTS_CACHE_HOME`、`MASON4AGENTS_STATE_HOME` 覆盖默认目录。

## v1 不支持的 Source 类型

以下 Mason source 类型已被识别但需要外部包管理器（`mason4agents doctor` 会报告它们的状态）：

- `npm`、`pypi`、`cargo`、`golang`、`gem`、`composer`、`luarocks`、`nuget`

构建脚本（`source.build.run`）**默认禁用**，需显式传递 `--allow-build-scripts`。

## v1 不包含

- Claude Code、Codex CLI、GitHub Copilot CLI、OpenCode 适配
- MCP server
- 自动修改 shell profile
- Neovim/mason.nvim 集成或依赖

## 许可证

Apache-2.0