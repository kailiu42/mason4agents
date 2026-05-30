# mason4agents
> TL;DR：如果你用过 [mason.nvim](https://github.com/mason-org/mason.nvim)，那它之于 coding agent 基本就是这个工具。

**基于 Mason Registry 的 coding agent 工具安装器。**

mason4agents 从 [Mason Registry](https://github.com/mason-org/mason-registry)（与 mason.nvim 使用同一 registry）下载和管理 LSP server、formatter、linter 等开发工具。工具会安装到用户家目录下符合 XDG 规范的位置，并通过 PATH 注入使 coding agent（如 [oh-my-pi](https://github.com/can1357/oh-my-pi)）可直接调用。

当前支持 **oh-my-pi**。未来版本可能支持 Claude Code、Codex CLI、Copilot、OpenCode 等。

## 为什么

安装 LSP server、linter、formatter 这类工具并不方便。很多工具并不在操作系统原生包管理器里，用户往往需要手动下载、安装和维护。

另一个问题是，你可能并不知道项目需要哪些工具。这个工具内置了一个相对基础的建议功能：它会扫描项目，优先使用 oh-my-pi 内置的 LSP 默认项，并在缺失时回退到 [LazyVim](https://github.com/LazyVim/LazyVim) 的信息来建议相关工具。

## 功能

- **Mason Registry 兼容** — 使用与 mason.nvim 相同的 registry、包 schema 和 release assets
- **OMP/Pi 扩展** — `/mason` 交互式包管理器、基于 CLI 的 slash 子命令、7 个 LLM 可调用工具、自动 PATH 注入
- **XDG Base Directory** — data、config、cache、state 遵循 `$XDG_*` 规范
- **默认安全** — 无 `--allow-build-scripts` 不执行构建脚本、zip-slip 防护、路径穿越拒绝、临时目录原子重命名
- **JSON 协议** — 所有 CLI 命令支持 `--json` 最终 envelope；耗时操作会在 stderr 以 NDJSON 流式输出 progress，并在可用时带上总字节数、下载百分比和当前速度
- **跨平台** — Linux、macOS、Windows（\*nix 用符号链接，Windows 用 `.cmd` wrapper）
- **不修改 shell profile** — `mason4agents env` 输出 `export PATH=...`，用户自行 sourcing

## 前置依赖

- **Rust 工具链**（stable，edition 2021）— 从源码构建
- **Bun**（v1.x）— 用于 TypeScript OMP/Pi 适配层
- **oh-my-pi (OMP) 或 Pi CLI** — 用于扩展集成
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

### 通过 npm 包接入 oh-my-pi (OMP) / Pi

```bash
# 使用 oh-my-pi (OMP) 安装
omp plugin install mason4agents

# 或使用 Pi 安装
pi install npm:mason4agents

# 使用 OMP 本地测试（无需发布）
omp --extension ./dist/pi/extension.js
# 或
pi --offline -e dist/pi/extension.js
```

### 二进制文件查找顺序

npm shim 和 OMP/Pi 扩展按以下顺序定位 Rust 二进制文件：

1. `MASON4AGENTS_BIN` 环境变量
2. 内置的 `native/mason4agents-{platform}-{arch}` 或 `dist/native/...`（本地/源码构建和旧包）
3. 已安装的 native optional dependency 包，例如 `mason4agents-linux-x64-gnu`
4. 开发目录 `target/debug/mason4agents` / `target/release/mason4agents`（`cargo build` 后）

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

### OMP/Pi 扩展

在 OMP/Pi 中打开交互式包管理器：

```
/mason
```

Panel 会以匹配宿主宽度、跟随宿主 theme 的 TUI 打开，顶部展示可见 tabs（`list`、`suggested`、`installed`、`check update`、`refresh`、`doctor`），下方是自适应宽度的表格区域。`suggested` tab 会扫描本地项目，LSP 推荐优先使用 OMP 内置默认支持列表；如果某个语言不在 OMP 默认列表中，再退回到本地缓存的 LazyVim curated 建议。表格视图会直接显示 installed 状态，保留整行高亮的当前选中行，并支持 `Tab`/`←`/`→` 切换 tab、`/` 本地过滤、`↑`/`↓` 选择行、`Enter` 打开原位包详情弹窗，以及按安装状态变化的包操作：未安装包使用 `i`，已安装包使用 `u`/`d`。耗时操作（`install`、`update`、`uninstall`、`refresh`）会显示模态 progress panel；CLI 运行期间会屏蔽其它 Mason 操作，30s 无新进展后进入可用 `q`/`Esc` 关闭 panel 的提示态，关闭不会杀掉 CLI，最终结果会保留在该 panel 中。

不需要打开 panel 时，可直接运行基于 CLI 的等价 slash 子命令。无参数 `/mason` 会打开 TUI；在仅有 `/mason ` 的提示后按 `Tab` 会显示全部子命令，输入前缀后会收窄子命令建议，并在回车前展示对应命令可传入的参数形状：

```text
/mason search stylua --language Lua
/mason installed
/mason list --outdated
/mason install stylua
/mason uninstall stylua
/mason doctor
/mason register --omp
```

直接非耗时 slash 命令结果会渲染为人类可读的表格或摘要，不会输出原始 JSON。直接耗时命令（`/mason install`、`/mason update`、`/mason uninstall`、`/mason refresh`）在可用 custom UI 时使用同一个 progress panel，否则退回到最终渲染结果。

OMP/Pi 中可使用以下工具（底层调用 Rust CLI）：

| 工具 | 说明 |
|---|---|
| `mason_list` | 列出已安装/过期的包 |
| `mason_search` | 搜索 registry（支持 query、category、language 过滤） |
| `mason_install` | 安装一个或多个包 |
| `mason_uninstall` | 卸载包 |
| `mason_update` | 更新包（全部或指定） |
| `mason_which` | 查找已安装的二进制路径 |
| `mason_env` | 生成 shell PATH 设置 |

### CLI 命令

npm package/Pi TypeScript shim 暴露以下命令面。直接从源码构建的 native Rust binary（例如 `target/release/mason4agents`）支持除 `register --omp` 以外的相同命令；`register --omp` 由 shim 实现，用于更新 OMP/Pi 注册。
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

默认情况下，所有命令输出人类可读文本。添加 `--json` 可获取最终结构化 JSON envelope，包裹在 `{"ok": true, "data": ...}` 中；耗时操作的 progress event 会以 `kind: "progress"` 的 NDJSON object 写入 stderr，stdout 仍只保留最终 envelope。对于下载阶段，如果远端返回了内容长度，progress event 还会包含 `total_bytes`、`downloaded_bytes`、`download_percent` 和 `bytes_per_second`。
通过 OMP/Pi 扩展或 npm CLI 执行安装、更新、卸载成功后，会自动刷新 OMP LSP 注册。可从 npm package/Pi shim 运行 `mason4agents register --omp`，手动把已安装的 Mason LSP 工具注册到 oh-my-pi；不要在直接从源码构建的 native Rust CLI 上使用该子命令。

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

## 构建

该包包含三个交付件：**Rust CLI**（核心）、**npm shim** 和 **OMP/Pi 扩展**（TypeScript）。

### 一键构建（推荐）

```bash
bun run build
```

此命令依次执行：

1. `bun run build:js` 打包 TypeScript npm shim（`dist/bin/mason4agents.js`）和 OMP/Pi 扩展（`dist/pi/extension.js`）
2. `bun run build:native` 运行 `cargo build --release`
3. 将当前平台 release 二进制复制到 `native/`，用于本地 resolver fallback 和 native package staging

### 单独构建各组件

```bash
# 仅 Rust CLI
cargo build --release                          # 二进制: target/release/mason4agents
cargo build                                    # 调试二进制: target/debug/mason4agents

# 仅 JS 入口
bun run build:js

# Rust CLI 加当前平台 native/ staging copy
bun run build:native
```

### 构建产物

| 产物 | 路径 | 用途 |
|---|---|---|
| Rust CLI | `target/release/mason4agents` | 直接命令行使用 |
| Rust CLI (开发) | `target/debug/mason4agents` | OMP/Pi 扩展开发回退 |
| 本地 native 二进制 | `native/mason4agents-{platform}-{arch}` | 内置/本地 resolver fallback |
| 发布 native artifact | `native/mason4agents-linux-x64-gnu`、`native/mason4agents-win32-x64.exe` 等 | 平台专属 npm native 包 |
| npm shim | `dist/bin/mason4agents.js` | `npx mason4agents` |
| OMP/Pi 扩展 | `dist/pi/extension.js` | `omp --extension ./dist/pi/extension.js` / `pi --offline -e dist/pi/extension.js` |

### 打包、CI 与发布

```bash
# 构建当前平台 tarball，用于本地安装测试
bun run pack:local

# 同一本地 tarball 流程的别名
bun run publish:local

# 从预构建的多平台 artifacts 发布（通常只在 GitHub release CI 中执行）
bun run publish:npm
```

发布到 npm 时采用小型主包 `mason4agents` 加平台 native optional dependencies 的结构：`mason4agents-linux-x64-gnu`、`mason4agents-linux-arm64-gnu`、`mason4agents-darwin-x64`、`mason4agents-darwin-arm64`、`mason4agents-win32-x64`、`mason4agents-win32-arm64`。native 包只包含 `package.json`、`LICENSE`、`bin/mason4agents` 或 `bin/mason4agents.exe`，且不声明自己的 `bin` 字段。

GitHub Actions 包含两个 workflow：

- `ci.yml` 在分支 push 和 pull request 上运行。它执行 Rust/TypeScript/Bun 质量门，并在 Linux、macOS、Windows 的 x64 与 arm64 runner 上构建和 smoke-test CLI artifacts。
- `release.yml` 在 `v*` tag 上运行。它从 tag 重新构建，上传六个平台 native artifacts，生成 npm staging 包，校验 `npm pack --dry-run --json` 内容，先发布所有 native 包，再发布主包。

tag release 应使用 `vX.Y.Z`，且 tag 必须匹配 `package.json` 版本。六个 native 子包首次发布需要 npm bootstrap（本地登录或临时 `NPM_TOKEN`），因为 npm Trusted Publishing 只能为已经存在的包配置。bootstrap 后，为 `mason4agents` 和六个 native 包配置指向 `.github/workflows/release.yml` 的 Trusted Publishing，然后移除临时 token。

## 测试

### Rust

```bash
cargo test                         # Rust 测试套件
cargo test cli_fixture             # 仅 CLI 集成测试
cargo test -- --ignored            # 包含网络 smoke 测试
```

### TypeScript

```bash
bun test                           # TypeScript 测试套件
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
~/.cache/mason4agents/
  registry/                          # Registry 缓存 + 校验和
  downloads/                         # 下载的归档文件（可清理）
  logs/                              # 安装日志
~/.local/state/mason4agents/
  installed.json                     # 安装状态数据库
  locks/                             # 安装/更新锁文件
```

可通过 `MASON4AGENTS_CONFIG_HOME`、`MASON4AGENTS_DATA_HOME`、`MASON4AGENTS_CACHE_HOME`、`MASON4AGENTS_STATE_HOME` 覆盖默认目录。

## 需要外部管理器的 Source 类型

以下 Mason source 类型会通过外部包管理器安装（`mason4agents doctor` 会报告它们的可用状态）：

- `npm`、`pypi`、`cargo`、`golang`、`gem`、`composer`、`luarocks`、`nuget`

构建脚本（`source.build.run`）**默认禁用**，需显式传递 `--allow-build-scripts`。

## 当前不包含的内容

- Claude Code、Codex CLI、GitHub Copilot CLI、OpenCode 适配
- 自动修改 shell profile
- Neovim/mason.nvim 集成或依赖

## 许可证

MIT
