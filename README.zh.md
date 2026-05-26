# mason4agents
> TL;DR：如果你用过 [mason.nvim](https://github.com/mason-org/mason.nvim)，那它之于 coding agent 基本就是这个工具。

**基于 Mason Registry 的 coding agent 工具安装器。**

mason4agents 从 [Mason Registry](https://github.com/mason-org/mason-registry)（与 mason.nvim 使用同一 registry）下载和管理 LSP server、formatter、linter 等开发工具。工具安装到符合 XDG 规范的目录，并通过 PATH 注入使 coding agent（如 [Oh My Pi](https://ohmyPi.com)）可直接调用。

v1 支持 **Pi CLI**（v0.75.5+）。后续版本可能增加 Claude Code、Codex CLI、Copilot、OpenCode 及 MCP 适配。

## 功能

- **Mason Registry 兼容** — 使用与 mason.nvim 相同的 registry、包 schema 和 release assets
- **Pi 扩展** — `/mason` 交互式包管理器、等价 CLI 的 slash 子命令、7 个 LLM 可调用工具、自动 PATH 注入
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

### 从源码安装

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

在 Pi 中打开交互式包管理器：

```
/mason
```

Panel 会以匹配宿主宽度、跟随宿主 theme 的 TUI 打开，顶部展示可见 tabs（`list`、`suggested`、`installed`、`check update`、`refresh`、`doctor`），下方是自适应宽度的表格区域。`suggested` tab 会扫描本地项目，LSP 推荐优先使用 OMP 内置默认支持列表；如果某个语言不在 OMP 默认列表中，再退回到本地缓存的 LazyVim curated 建议。表格视图会直接显示 installed 状态，保留整行高亮的当前选中行，并支持 `Tab`/`←`/`→` 切换 tab、`/` 本地过滤、`↑`/`↓` 选择行、`Enter` 打开原位包详情弹窗，以及按安装状态变化的包操作：未安装包使用 `i`，已安装包使用 `u`/`r`。

不需要打开 panel 时，可直接运行等价 CLI 的 slash 子命令：

```text
/mason search stylua --language Lua
/mason installed
/mason list --outdated
/mason install stylua
/mason uninstall stylua
/mason doctor
/mason register --omp
/mason-doctor
```

直接 slash 命令结果会渲染为人类可读的表格或摘要，不会输出原始 JSON。

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
mason4agents register --omp
```

默认情况下，所有命令输出人类可读文本。添加 `--json` 可获取结构化的 JSON 输出，包裹在 `{"ok": true, "data": ...}` 中。
通过 Pi 扩展或 npm CLI 执行安装、更新、卸载成功后，会自动刷新 OMP LSP 注册。可运行 `mason4agents register --omp`，手动把已安装的 Mason LSP 工具注册到 Oh My Pi。

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

## 构建 Plugin

插件包含两个组件：**Rust CLI**（核心）和 **Pi 扩展**（TypeScript）。

### 一键构建（推荐）

```bash
bun run build
```

此命令依次执行：
1. `bun build` 打包 TypeScript npm shim（`dist/bin/mason4agents.js`）
2. `bun build` 打包 Pi 扩展（`dist/pi/extension.js`）
3. `cargo build --release` 编译 Rust CLI
4. 将 release 二进制复制到 `native/mason4agents-{platform}-{arch}`

### 单独构建各组件

```bash
# 仅 Rust CLI
cargo build --release                          # 二进制: target/release/mason4agents
cargo build                                    # 调试二进制: target/debug/mason4agents

# 仅 Pi 扩展（TypeScript 打包）
./node_modules/.bin/tsc --noEmit               # 类型检查
bun build src/pi/extension.ts --outdir dist/pi --target bun
```

### 构建产物

| 产物 | 路径 | 用途 |
|---|---|---|
| Rust CLI | `target/release/mason4agents` | 直接命令行使用 |
| Rust CLI (开发) | `target/debug/mason4agents` | Pi 扩展开发回退 |
| 原生二进制 | `native/mason4agents-{platform}-{arch}` | Pi 扩展内置查找 |
| npm shim | `dist/bin/mason4agents.js` | `npx mason4agents` |
| Pi 扩展 | `dist/pi/extension.js` | `pi --offline -e dist/pi/extension.js` |

### 打包并发布当前平台

```bash
# 构建本地 tarball，用于安装测试
bun run publish:local

# 同一本地 tarball 流程的别名
bun run pack:local

# 真正发布到 npm
bun run publish:npm
```

这些命令会把当前平台二进制打包为 `native/mason4agents-{platform}-{arch}`。如果要发布多平台 npm 包，请先补齐其它 `native/mason4agents-*` 二进制，再执行发布命令。

## 测试

### Rust

```bash
cargo test                         # 42 个测试（40 单元 + 2 集成）
cargo test cli_fixture             # 仅 CLI 集成测试
cargo test -- --ignored            # 包含网络 smoke 测试
```

### TypeScript

```bash
bun test                           # 19 个测试
```

### 完整验证

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && ./node_modules/.bin/tsc --noEmit && bun test
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
