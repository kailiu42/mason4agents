# Bug Hunting 计划

本文记录一次全仓库 review 发现的可执行问题。每个问题都独立包含技术细节，后续处理时不需要重新从零分析上下文。

## P1：update-all 状态锁竞争

- 分类：并发一致性 / 安装状态
- 位置：`crates/mason4agents/src/installer.rs:170-180`

### 现象和影响

`mason4agents update` 不传包名时，会更新当前所有已安装包。当前实现先在 state lock 下读取 `installed.json`，生成包名列表，然后显式 `drop(_state_lock)`，再进入安装流程。

如果另一个进程在释放锁之后执行 `uninstall`，update 仍然会使用旧快照继续安装这个包，导致已经成功卸载的包被重新装回去。

### 技术细节

当前流程：

1. `update_packages()` 获取全局 state lock。
2. `InstalledState::load()` 读取已安装包。
3. 空参数时用 `state.packages.keys()` 生成 `requests`。
4. `drop(_state_lock)`。
5. 调用 `install_requests_for_operation("update", &requests, ...)`。

问题出在第 4 步和第 5 步之间。`requests` 是旧状态快照，不再受锁保护。后续 install 会重新获取锁并写入状态，但它无法区分“用户刚刚卸载了该包”和“包仍然应该被 update”。

### 修复方向

可选方案：

- 保持 state lock 覆盖 update-all 的整个请求确认和安装过程。
- 或者在每个包安装前重新在锁内确认该包仍存在于 state 中，不存在则跳过。

需要注意锁顺序仍必须满足现有约束：先全局 state lock，再 package lock，避免死锁。

### 验证建议

增加 Rust 集成测试或单元测试，模拟：

1. 初始安装包 A。
2. update-all 生成请求后，另一路径卸载 A。
3. update 不应把 A 重新写回 state，也不应恢复 bin link。

如果难以直接并发测试，可以把请求生成和安装确认逻辑拆成可测函数，验证 state 已缺失时 update-all 会跳过。

## P1：`state.save()` 失败后安装残留

- 分类：事务一致性 / rollback
- 位置：`crates/mason4agents/src/installer.rs:489-506`

### 现象和影响

安装流程已经完成包目录落地和链接创建后，最后调用 `state.save()` 写入 `installed.json`。如果此时保存失败，命令返回错误，但文件系统上的包目录和 bin/share/opt 链接已经存在。

结果是：

- `list --installed` 看不到该包。
- `uninstall` 依赖 state，无法可靠清理这些孤儿链接。
- `which` 可能能找到可执行文件，但 state 中没有对应 package。

### 技术细节

当前代码先构造 `InstalledPackage`，然后：

1. `state.packages.insert(package.name.clone(), installed)`。
2. `state.save(&self.paths)?`。
3. 成功后返回 `InstallResult`。

在这之前，安装目录已经从临时目录 rename 到最终目录，`link_package_files()` 也已经创建了链接。`state.save()` 是 fallible IO：磁盘满、权限错误、rename 失败都可能发生。这个错误路径目前没有清理 `receipt` 中的新链接，也没有删除新 package dir 或恢复 previous receipt。

### 修复方向

把 `state.save()` 失败纳入 rollback：

- 保存失败时调用 `cleanup_package_links()` 清理本次新 receipt 对应链接。
- 删除本次新 package dir。
- 如果是 update 覆盖已有版本，需要恢复 previous receipt 的链接和旧 package dir 状态。

更稳妥的方向是把 install filesystem commit 和 state commit 设计成显式事务，所有 fallible commit 点都有反向补偿。

### 验证建议

增加测试覆盖 `state.save()` 失败：

- 可通过让 state path 不可写、把 state file parent 替换成文件、或注入 failing save helper 来模拟。
- 断言命令失败后：package dir 不存在，bin/share/opt link 不存在，旧版本链接在 update 场景下仍存在。

## P1：npm lifecycle scripts 默认未禁用

- 分类：安全 / build script gate
- 位置：`crates/mason4agents/src/installers/manager.rs:206-213`

### 现象和影响

项目规则要求 build scripts 必须由 `--allow-build-scripts` 显式开启。但 npm 安装路径调用的是普通 `npm install`，没有传 `--ignore-scripts`。npm 默认会执行 `preinstall`、`install`、`postinstall` 等 lifecycle scripts。

这意味着即使用户没有传 `--allow-build-scripts`，恶意或复杂 npm 包仍可执行脚本，绕过安全开关。

### 技术细节

`npm_command()` 当前构造参数：

```text
npm install --prefix <staging> <package>@<version> ...extra_packages
```

`allow_build_scripts` gate 目前只覆盖 Mason registry source 中的 `build.run`。但 npm 自身 lifecycle script 不经过 `build::run_build_scripts_with_progress()`，因此不会被 gate。

### 修复方向

需要把 `allow_build_scripts` 传入 manager command 构造层：

- 默认 npm 命令加 `--ignore-scripts`。
- 只有用户显式传 `--allow-build-scripts` 时才允许 npm lifecycle scripts。

同时检查其它 package manager 是否有同类默认脚本行为：例如 cargo/pip/go/npm 的安装过程是否会执行项目脚本。如果有，也要统一受同一 flag 控制或明确记录为什么安全。

### 验证建议

增加 manager command 单元测试：

- 默认 npm command 包含 `--ignore-scripts`。
- `allow_build_scripts = true` 时不包含该参数。
- CLI 集成测试可用 fixture npm package 写入 `postinstall` 副作用文件，默认安装不应生成该文件，允许脚本时才生成。

## P1：tar 解包允许非普通文件落地

- 分类：归档安全 / filesystem safety
- 位置：`crates/mason4agents/src/archive.rs:147-160`

### 现象和影响

tar 解包逻辑已拒绝 symlink 和 hardlink，但其它特殊条目没有被拒绝。FIFO、block device、char device 等非普通文件会进入 `entry.unpack(&out)`。

如果 archive 中包含特殊文件，安装过程可能在 package dir 中创建非预期 filesystem object，破坏“安全归档提取”的边界。

### 技术细节

当前逻辑：

1. 前面拒绝 symlink/hardlink。
2. 如果 `kind.is_dir()`，创建目录并 continue。
3. 否则直接认为是文件路径，检查 duplicate 后 `entry.unpack(&out)`。

缺少 `kind.is_file()` 检查。tar crate 会根据 entry type 执行对应 unpack 行为，非普通条目不应该进入这个路径。

### 修复方向

在目录分支后增加明确拒绝：

- 允许：regular file、directory。
- 拒绝：symlink、hardlink、FIFO、block device、char device、其它未知类型。

错误类型应继续使用 `M4aError::UnsafeArchiveEntry`，错误信息包含 entry path 和 type，方便诊断。

### 验证建议

增加 archive 单元测试：

- 构造 tar fixture，包含 FIFO 或特殊 entry type。
- `extract_archive()` 应返回 `UnsafeArchiveEntry`。
- 确认目标目录中没有创建该特殊条目。

## P2：Windows `which` 返回不存在的裸路径

- 分类：平台兼容性 / CLI contract
- 位置：`crates/mason4agents/src/installer.rs:301-310`

### 现象和影响

Windows 下 bin link 通常是 `<name>.cmd` wrapper。`which` 当前会检查 `.cmd` 是否存在，但返回值仍是无扩展名的 bare path。

对 JSON 调用方而言，`data.path` 指向一个不存在的文件，直接执行会失败。

### 技术细节

当前逻辑：

1. `bare_path = bin_dir.join(executable)`。
2. `exists = bare_path.exists()`。
3. Windows 下如果 `<executable>.cmd` 存在，也把 `exists` 置为 true。
4. `path = if exists { Some(bare_path) } else { None }`。

第 3 步检测的是 wrapper，第 4 步返回的却不是 wrapper。

### 修复方向

Windows 下应区分实际命中的路径：

- 如果 bare path 存在，返回 bare path。
- 否则如果 `.cmd` 存在，返回 `.cmd` path。
- 否则返回 None。

非 Windows 行为保持不变。

### 验证建议

增加 Windows cfg 单元测试，或抽出路径选择函数做跨平台测试：

- 仅 `.cmd` 存在时，返回 `.cmd`。
- bare 和 `.cmd` 都存在时，返回 bare。
- 都不存在时返回 None。

## P2：LSP sync 覆盖用户显式非 Mason 绝对路径

- 分类：用户配置保护 / integration correctness
- 位置：`src/pi/lsp-config.ts:320-324`

### 现象和影响

如果用户已有配置：

```json
{"rust-analyzer": {"command": "/usr/bin/rust-analyzer"}}
```

Mason sync 生成的 next command basename 也是 `rust-analyzer`。当前逻辑只要 basename 相同就允许更新，因此会把用户显式指定的系统路径替换成 Mason bin 路径。

这会静默劫持用户配置。

### 技术细节

`shouldUpdateCommand(current, next, binDir)` 当前判断：

1. current 不是 string 或为空，更新。
2. current 等于 next，不更新。
3. `basename(current) === basename(next)`，更新。
4. current resolve 后位于 Mason binDir 内，更新。

第 3 条没有区分 bare command 和 absolute path。对 absolute path，basename 相同不代表它属于 Mason 管理范围。

### 修复方向

建议规则：

- bare command，例如 `rust-analyzer`，可以被 Mason command 替换。
- 已经在 Mason binDir 内的路径，可以被更新。
- 绝对路径或相对路径指向非 Mason 位置时，不应仅因 basename 相同而替换。

需要注意 Windows 路径和 shell command 字符串的处理，避免 `basename()` 对带参数 command 误判；如果 command 可能包含参数，应先确认当前 schema 是否允许。

### 验证建议

增加 Bun 测试：

- existing command `/usr/bin/rust-analyzer`，sync 后保持不变。
- existing command `rust-analyzer`，sync 后可替换为 Mason bin path。
- existing command 位于 Mason binDir 内，sync 后可更新。

## P2：`lsp.json` 非原子写入

- 分类：配置文件可靠性 / atomic write
- 位置：`src/pi/lsp-config.ts:152-153`

### 现象和影响

`syncMasonLspConfig()` 直接 `writeFileSync(configPath, ...)` 写最终 `.omp/agent/lsp.json`。如果进程中断、系统崩溃或 ENOSPC 发生在写入中间，用户配置可能被截断。

更糟的是，下一次 sync 遇到 invalid JSON 会返回 skipped，不会自动修复截断文件。

### 技术细节

当前流程：

1. 读取 existing config。
2. 合并 Mason servers。
3. `mkdirSync(dirname(configPath), { recursive: true })`。
4. `writeFileSync(configPath, serializedJson)`。

没有同目录临时文件，也没有 rename。POSIX rename 同目录通常是原子的，可避免最终文件处于半写状态。

### 修复方向

实现 atomic write：

1. 在 `dirname(configPath)` 下创建带 pid/random suffix 的 tmp 文件。
2. 写完整 JSON。
3. 可选 fsync tmp file 和 parent dir。
4. rename tmp 到 configPath。
5. 失败时清理 tmp。

Windows 下 rename 覆盖语义需确认 Node 行为；必要时先 unlink 目标或使用合适的替换流程。

### 验证建议

增加 Bun 单元测试：

- mock 或注入 write failure，确认不会覆盖原 config。
- 正常 sync 后 config 内容完整。
- tmp 文件失败路径被清理。

## P2：TUI package 操作后的 refresh 缺少 stale-result 防护

- 分类：异步竞态 / UI 状态一致性
- 位置：`src/tui/mason-tui.ts:1374-1379`

### 现象和影响

普通 TUI command run 有 run-id 防护，避免旧请求覆盖新界面。但 install/update/uninstall 完成后的 `refreshAfterPackageChange()` 直接调用 `host.runCli()` 并应用结果。

如果用户在 refresh pending 时切换 tab、输入 search 或执行其它命令，旧 refresh 返回后可能覆盖当前 model/table。

### 技术细节

当前流程：

1. package command 完成。
2. `refreshAfterPackageChange()` 根据当前 state 构造 `planned = buildInvocation(state)`。
3. `await host.runCli(planned.argv)`。
4. 无条件写入 `state.lastAction`、`state.model`、`state.packages`。

问题是 await 期间 state 可能已经变化。普通 run 通常会递增 `commandRunId` 并在 await 后检查当前 id 是否仍匹配；这里没有类似 guard。

### 修复方向

给 post-package refresh 也加 stale guard：

- refresh 开始时捕获 run id 或递增专用 refresh id。
- await 返回后，如果 state.command/input/filter 等关键上下文已变化，则丢弃结果。
- 或统一复用普通 command run 管线，避免第二套异步状态更新逻辑。

### 验证建议

增加 TUI Bun 测试：

1. install 完成后 refresh 返回 pending promise。
2. 在 promise resolve 前切换到另一个 tab 或 search。
3. resolve 旧 refresh。
4. 断言当前 tab/model 未被旧结果覆盖。

## P2：Pi `list/search` tools 缺 `registry` 参数

- 分类：API 一致性 / tool integration
- 位置：`src/pi/pi-tools.ts:26-39`, `src/pi/pi-tools.ts:135-136`

### 现象和影响

slash command 支持：

- `mason search ... --registry <source>`
- `mason list ... --registry <source>`

install/update tools 也支持 registry。但 Pi LLM tools 中 `mason_list` 和 `mason_search` 的 schema 没有 `registry`，executor 也不转发。

结果是 tool-driven flow 无法在同一个 alternate/local registry 上 search/list/install，可能先从默认 registry 查询，再从指定 registry 安装，造成结果不一致。

### 技术细节

当前代码：

- `mason_list` 只处理 `installed` 和 `outdated`。
- `mason_search` 只处理 `query`、`category`、`language`。
- `listSchema()` 和 `searchSchema()` 没有 `registry` optional field。

CLI parser 和 slash command 已有 registry 语义，Pi tool API 漏转发。

### 修复方向

- `listSchema()` 增加 `registry: Type.Optional(Type.String())`。
- `searchSchema()` 增加 `registry: Type.Optional(Type.String())`。
- executor 中非空 string 时 append `--registry`, value。
- 保持 TypeBox optional 使用 `Type.Optional(...)`，符合项目规则。

### 验证建议

增加 `test/pi/pi-tools.test.ts`：

- `mason_list({ registry: "fixture" })` 调用 bridge args 包含 `--registry fixture`。
- `mason_search({ query, registry })` 同理。
- missing registry 时 args 不变。

## P2：下载整包进入内存

- 分类：资源使用 / 大文件稳定性
- 位置：`crates/mason4agents/src/download.rs:190-209`

### 现象和影响

远程 artifact 下载时，`DownloadBuffer` 把所有响应 chunk append 到 `Vec<u8>`，最后返回完整 bytes。大 artifact 或异常大的响应会占用同等大小内存，可能导致 OOM。

安装器处理的是外部 registry artifact，不能假设大小总是小。

### 技术细节

当前 `DownloadBuffer`：

1. 根据 `Content-Length` 尝试 `Vec::reserve(total_bytes)`。
2. `write()` 中 `extend_from_slice(buf)`。
3. `finish()` 返回整块 `Vec<u8>`。
4. 调用方再把 bytes 写入 cache file。

这导致数据同时经历网络 buffer、内存 Vec、文件写入。对于下载场景，进度上报不要求持有完整 bytes。

### 修复方向

改为流式下载到同目录临时文件：

- response body copy 到 `File` writer。
- writer 同时维护 downloaded bytes 并上报 progress。
- 完成后 rename tmp 到 cache path。
- 校验失败或中断时删除 tmp。

如果某些调用方确实需要 bytes，应区分小型 metadata 下载和大型 artifact 下载，不要让 install artifact 走整包内存路径。

### 验证建议

增加 download 单元测试：

- 使用 fake reader 大量分块，确认输出文件正确。
- 确认 progress 仍按 downloaded bytes 上报。
- 确认失败时 tmp 文件清理。

## P2：installed 表格窄屏丢 `Installed At` 列

- 分类：TUI 响应式布局
- 位置：`src/tui/mason-render.ts:210-213`

### 现象和影响

installed 表格目前把列最小宽度固定为：

- Name：30
- Version：20
- Bins：30
- Installed At：32

列间 separator 三个，每个 2 字符，因此 table 最小宽度为 `30 + 20 + 30 + 32 + 6 = 118`。如果有 selected row prefix，外层可用 table width 是 `width - 2`，所以终端总宽低于 120 时，完整四列无法同时显示。

当前 `computeColumnLayout()` 在最小宽度超出时会减少列数，尾部列先被丢弃。因此 96 列等常见宽度下 `Installed At` 会消失。

### 技术细节

`computeColumnLayout()`：

1. 从完整 column count 开始。
2. 当 `minimumTableWidth(columns, count) > width` 时，`count -= 1`。
3. installed 表格尾列是 `Installed At`，所以它首先被删。

这不是 wrap，而是整列不可见。用户要求的 30/20/30/32 更像理想宽度或上限，不适合作为所有列的硬性 minWidth。

### 修复方向

保留目标宽度，但让窄屏可以收缩：

- 把 30/20/30/32 设置为 `maxWidth` 或 preferred width，而不是全部 minWidth。
- 给 Name/Bins/Installed At 设合理 minWidth，例如 Name 12、Version 8、Bins 8、Installed At 20。
- 或扩展布局算法支持 preferredWidth：宽屏用 preferred，窄屏降到 min 后 wrap。

不要通过直接丢尾列解决窄屏问题，除非 UI 明确提供横向滚动或详情入口提示。

### 验证建议

更新 TUI 测试：

- width 120 时列间距符合目标宽度。
- width 96 时仍能看到 `Installed At` header 或 timestamp 的 wrapped 内容。
- 所有行长度仍不超过 width。
