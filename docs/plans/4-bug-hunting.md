# Bug Hunting 计划

本文记录一次全仓库 review 发现的可执行问题。每个问题都独立包含技术细节，后续处理时不需要重新从零分析上下文。

## P1：update-all 状态锁竞争

- 分类：并发一致性 / 安装状态
- 位置：`crates/mason4agents/src/installer.rs:170-180`
- 状态：已处理（commit `f6868de`）

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
- 状态：已处理（commit `f6868de`）

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
- 状态：已处理（commit `be27f1c`）

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
- 状态：已处理（commit `020a359`）

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
- 状态：已处理（commit `de4db3f`）

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
- 状态：已处理（commit `91a85ac`）

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
- 状态：已处理（commit `91a85ac`）

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
- 状态：已处理（commit `24a4329`）

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
- 状态：已处理（commit `c4ea010`）

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
- 状态：已处理（commit `0ee36c5`）

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
- 状态：已处理（commit `24a4329`）

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

# 新增待处理问题（第二轮全量 review）

以下问题来自第二轮全量代码 review。上方问题已经处理；本节全部为新增待处理项。每个问题都保留可直接开工的技术细节。

## P1：Windows 上 `InstalledState::save` 不能覆盖已有 state 文件

- 状态：已处理（本次修改，待提交）
- 分类：Windows / state consistency
- 位置：`crates/mason4agents/src/store.rs:37-42`

### 现象和影响

`InstalledState::save()` 使用临时文件写入 `installed.json.tmp-<pid>`，随后调用 `fs::rename(tmp, &paths.state_file)`。在 Unix 上 rename 可以覆盖已有目标文件；但 Windows 的 `std::fs::rename` 在目标已存在时会失败。

这意味着 Windows 上第一次写入 state 可能成功，但只要 `installed.json` 已存在，后续 install、update、uninstall 只要保存 state 就会失败。失败发生在核心状态提交路径，会让 Windows 安装流程不可持续使用。

### 技术细节

当前保存流程：

1. `fs::create_dir_all(parent)`。
2. 写入固定名称临时文件 `installed.json.tmp-<pid>`。
3. `fs::rename(tmp, &paths.state_file)`。

问题点：

- Windows rename 不替换已有文件。
- 临时文件名只包含 pid，同一进程内多次失败/重试也可能撞上残留 tmp。
- install 的 rollback 修复依赖 `state.save()` 的错误语义；如果 Windows 正常更新永远失败，会触发不必要 rollback。

### 修复方向

实现跨平台 atomic replace helper：

- 同目录写临时文件。
- Unix 可直接 rename。
- Windows 需要先删除/替换目标，或使用平台支持的 replace semantics。
- 如果采用先删除再 rename，需要考虑删除后 rename 失败时的恢复路径；更建议封装统一 helper 并测试。
- 临时文件名应包含随机/单调 nonce，避免同进程残留冲突。

### 验证建议

增加单元测试覆盖路径提交 helper：

- 目标不存在时写入成功。
- 目标已存在时第二次保存成功，内容更新。
- 模拟 tmp 残留时不会因为固定 tmp 名冲突而失败。
- 如果无法在 Linux 上直接验证 Windows rename 语义，至少把 replace helper 抽象成可测逻辑，并在 Windows cfg 测试中覆盖。

## P2：uninstall 在 `state.save()` 失败时没有 rollback

- 状态：已处理（本次修改，待提交）
- 分类：rollback / state consistency
- 位置：`crates/mason4agents/src/installer.rs:262-307`

### 现象和影响

`uninstall_with_progress()` 在内存 state 中移除 package 后，先删除 package links 和 package dir，最后才调用 `state.save()`。如果保存 state 失败，磁盘上的 `installed.json` 仍记录该包已安装，但实际文件和链接已经被删除。

结果：

- `list --installed` 仍显示该包。
- `which` 可能找不到可执行文件。
- 再次 uninstall 可能只能清理一个已经不存在的目录/链接，错误恢复路径不明确。

### 技术细节

当前流程：

1. 获取 state lock。
2. `state.packages.remove(package)`。
3. `cleanup_package_links()` 删除 bin/share/opt links。
4. `fs::remove_dir_all(package_dir)` 删除包目录。
5. 循环结束后 `state.save(&self.paths)?`。

问题是第 3、4 步已经不可逆地改变 filesystem，第 5 步才提交 state。install/update 已经有 state save 失败 rollback，但 uninstall 还没有等价补偿。

### 修复方向

可选方案：

- 先把 package dir 移到临时 old dir，清理 links，再保存 state；若保存失败，把 dir rename 回去并重建 links。
- 或先写 state，再删除文件；但如果删除失败会出现 state 已移除而文件残留的问题，也需要补偿。

建议沿用 install rollback 思路：uninstall 变成显式事务：prepare remove -> save state -> finalize delete；失败时恢复原 receipt links 和 package dir。

### 验证建议

增加 Rust 测试：

- 安装带 bin/share/opt 的 fixture。
- 阻断下一次 state save。
- 执行 uninstall 并断言失败。
- 断言 state 仍显示 package，package dir、bin/share/opt links 都恢复存在。

## P2：不同 package 的 link 名称冲突会互相覆盖

- 状态：已处理（本次修改，待提交）
- 分类：installer state consistency / link ownership
- 位置：`crates/mason4agents/src/linker.rs:41-54`

### 现象和影响

安装 package B 时，如果它声明了 package A 已经拥有的 bin/share/opt 名称，`create_package_links()` 会直接调用 `replace_link()` 删除原 link 并创建新 link。state 中 A 和 B 都仍记录自己拥有这个 link，但 filesystem 只有 B 的 link。

后果：

- `which` 可能按 state 查到错误 owner。
- 卸载 B 会删除 link，A 仍显示安装但可执行入口丢失。
- share/opt 同名也会发生同类覆盖。

### 技术细节

`create_package_links()` 只根据当前 package 的 spec 创建链接，不读取全局 state，也不知道 link 是否属于其它 package。`replace_link()` 的行为是先 `remove_path_if_exists(dest)`，再创建 link/wrapper。

同包 update 需要允许替换旧 link；不同包之间应拒绝冲突。

### 修复方向

在 installer 层创建 links 前检查 ownership：

- 根据当前 `InstalledState` 遍历其它 package receipt 的 `bins/share/opt` keys。
- 如果新 package 的任一 key 被其它 package 占用，返回明确错误。
- 同 package update/reinstall 应允许替换。
- 检查应在删除 previous links 之前执行，避免错误路径破坏现有安装。

### 验证建议

增加 Rust 测试：

1. 安装 package A，提供 bin `tool`。
2. 安装 package B，也提供 bin `tool`。
3. 第二次安装应失败。
4. A 的 state、package dir、bin link 仍保持可用。

share/opt 可以加单元测试或同一个 integration fixture 覆盖。

## P2：Windows wrapper 路径生成不一致

- 状态：已处理（本次修改，待提交）
- 分类：Windows / path consistency
- 位置：`crates/mason4agents/src/linker.rs:244-256`

### 现象和影响

Windows 创建 wrapper 时使用 `dest.with_extension("cmd")`。如果 bin 名称是 `foo.bar`，目标 wrapper 会变成 `foo.cmd`。但 `which` 和 cleanup 逻辑通常按“追加 `.cmd`”查找，即 `foo.bar.cmd`。

这种不一致会导致：

- 安装后 `which foo.bar` 找不到实际 wrapper。
- uninstall 清理不到 `foo.cmd`，留下孤儿 wrapper。

### 技术细节

`Path::with_extension("cmd")` 不是追加扩展名，而是替换最后一个扩展名。对无扩展名 `foo`，结果是 `foo.cmd`；对有扩展名 `foo.bar`，结果是 `foo.cmd`。

此前 Windows `which` 修复采用 wrapper fallback，但如果 wrapper 创建路径和查找路径不一致，带点号的 bin 名仍有缺陷。

### 修复方向

统一 Windows wrapper path helper：

- 定义 `windows_wrapper_path(dest: &Path) -> PathBuf`。
- 如果项目语义是追加 `.cmd`，则用文件名字符串追加 `.cmd`。
- 创建、which、cleanup 全部使用同一 helper。
- 避免任意位置直接调用 `with_extension("cmd")`。

### 验证建议

增加 Rust 测试：

- wrapper helper 对 `foo` 返回 `foo.cmd`。
- 对 `foo.bar` 返回 `foo.bar.cmd`。
- install/which/uninstall 使用同一 helper，可在非 Windows 上测试 helper；Windows cfg 测试覆盖实际文件行为。

## P2：Windows 上重复下载同一 cache 文件会失败

- 状态：已处理（本次修改，待提交）
- 分类：Windows / download cache
- 位置：`crates/mason4agents/src/download.rs:146-154`

### 现象和影响

远程下载现在流式写入 tmp 文件，然后 `fs::rename(&tmp, &dest)` 提交 cache。Windows 上如果 `dest` 已存在，rename 会失败。重复安装或更新同一个 remote asset 时，cache 文件已经存在，后续下载会重试三次并失败。

### 技术细节

当前流程：

1. 根据 locator 计算 deterministic cache path。
2. 每次都重新请求 remote。
3. 写 tmp。
4. rename tmp 到 dest。

缺少两类处理：

- 如果 dest 已存在且可用，可以直接复用，避免下载。
- 如果确实要刷新，需要 replace-safe commit。

### 修复方向

优先策略：

- 如果 cache dest 已存在，直接返回 dest，避免重复下载和 Windows replace 问题。
- 如需强制刷新，新增显式 refresh 参数或先安全替换。

如果不复用，则使用与 state save 相同的跨平台 replace helper。

### 验证建议

增加 Rust 测试：

- 第一次 HTTP 下载成功写入 cache。
- 第二次相同 locator 不需要覆盖已存在文件，返回同一路径。
- 模拟 dest 已存在时提交不失败。

## P2：asset array 的额外文件被解析但未安装

- 状态：已处理（本次修改，待提交）
- 分类：asset selection / installer completeness
- 位置：`crates/mason4agents/src/installer.rs:655-669`

### 现象和影响

`source.asset.file` 支持 array，解析后第一个文件进入 `AssetSpec.file`，其余进入 `AssetSpec.extra_files`。但安装路径只下载和解包 `asset.file`，忽略 `extra_files`。

如果 Mason registry package 依赖多个 asset，例如主 binary 和额外 runtime 文件，当前安装会不完整，或者 link creation 因缺文件失败。

### 技术细节

`asset_from_json()` 已经保留 `extra_files`，说明模型层认为 array 是合法 registry 形态。但 `install_github_with_progress()` 只处理：

1. `package.source.asset.as_ref().and_then(|a| a.file.as_deref())`
2. 下载主 locator。
3. 解包到 staging。

没有循环处理 `extra_files`。

### 修复方向

两种选择：

- 完整支持：按 YAML 顺序下载并解包 `file + extra_files`，全部落入同一 staging dir；每个 locator 都支持 strip prefix。
- 暂时拒绝：如果 `extra_files` 非空，在 normalize/install 阶段返回明确 unsupported error。

更符合 Mason registry 语义的是完整支持，并保持 asset YAML order significant。

### 验证建议

增加 Rust 测试：

- registry fixture 使用 asset file array。
- 第一个 asset 提供 bin，第二个 asset 提供 share/opt 或辅助文件。
- 安装后所有文件存在，links 可用。

## P2：单个 asset object 的 `target` 未校验

- 状态：已处理（本次修改，待提交）
- 分类：platform / asset selection
- 位置：`crates/mason4agents/src/package_spec.rs:387-428`

### 现象和影响

array-form `source.asset` 会读取每个 item 的 `target` 并按 `Platform::candidates()` 匹配。object-form asset 则被直接接受，即使它声明了 `target` 且 target 不匹配当前平台。

一个只有 `target: win_x64` 的 object asset 可能在 Linux 上被 normalize 成可安装包，随后下载错误平台 artifact。

### 技术细节

`select_asset()` 当前分支：

- `Value::Array(items)`：筛选 target。
- `Value::Object(_)`：直接返回 `json_value`。

缺少 object target 检查。Mason registry 里 target 既可能出现在 array item，也可能出现在单 object。

### 修复方向

对 object asset：

- 如果没有 `target`，保持现有行为。
- 如果有 string/array target，则用 `Platform::candidates()` 判断是否匹配。
- 不匹配时返回 `M4aError::UnsupportedTarget`，并带上 declared targets。
- target 类型非法时返回 parse/validation error。

### 验证建议

增加 package_spec 测试：

- object asset target 匹配当前平台，normalize 成功。
- object asset target 不匹配，返回 `UnsupportedTarget`。
- object asset 无 target，保持现有成功行为。

## P2：`source.download` 选择错误被吞掉

- 状态：已处理（本次修改，待提交）
- 分类：platform / registry validation
- 位置：`crates/mason4agents/src/package_spec.rs:156-160`

### 现象和影响

`selected_source.download.as_ref().and_then(|raw| select_download_entry(raw, platform).ok()).flatten()` 把 `select_download_entry()` 的所有错误都转成 `None`。Malformed download spec 或 unsupported target 被静默丢弃。

后续 generic install 可能 fallback 到其它 asset，或在更晚阶段以“missing download”之类的模糊错误失败，定位困难。

### 技术细节

`.ok()` 丢弃了 `Result` 的错误信息。对于 registry 输入，错误本身是有意义的：

- download target 不支持当前平台，应返回 `UnsupportedTarget`。
- download spec 结构错误，应返回 parse/validation error。

当前行为把两者都变成“没有 download”。

### 修复方向

改为保留错误：

```rust
let download = selected_source
    .download
    .as_ref()
    .map(|raw| select_download_entry(raw, platform))
    .transpose()?
    .flatten();
```

或等价写法，确保错误传播。

### 验证建议

增加 package_spec 测试：

- unsupported download target 返回 `M4aError::UnsupportedTarget`。
- malformed download spec 返回错误。
- valid download array 仍选择最窄匹配项。

## P2：clap parse error 的 JSON 手写 escape 不完整

- 状态：已处理（本次修改，待提交）
- 分类：JSON/stdout contract
- 位置：`crates/mason4agents/src/main.rs:157-161`

### 现象和影响

`--json` 模式下 clap parse error 使用手写字符串拼 JSON，只替换了双引号。如果错误消息包含反斜杠、换行或其它 JSON 特殊字符，stdout 会变成非法 JSON。

对调用方而言，`--json` 模式承诺 stdout 是机器可解析 envelope；parse error 破坏这个契约。

### 技术细节

当前代码：

```rust
let msg = format!("{:?}", err);
println!(r#"{{"ok":false,..."message":"clap: {}"}}"#, msg.replace('"', "\\\""));
```

只处理 `"`，没有处理 `\`。例如用户输入 Windows path 或带反斜杠参数时，message 中的 `\t` / `\x` 可能被 JSON parser 当作 escape。

### 修复方向

使用 `serde_json` 构造 error envelope，复用现有 `error_json()` 或定义 parse-error 专用结构。不要手写 JSON 字符串。

### 验证建议

增加 CLI 测试：

- `mason4agents --json <invalid arg containing backslash>`。
- stdout 可被 `serde_json` parse。
- `ok == false`，`error.code == "parse_error"`。
- stderr/stdout contract 保持：JSON mode stdout 只有 envelope。

## P2：registry cache 写入非原子且无锁

- 状态：已处理（本次修改，待提交）
- 分类：locking / cache consistency
- 位置：`crates/mason4agents/src/registry.rs:82-86`

### 现象和影响

`refresh_registry_with_progress()` 生成 `index.json` 和 `index.sha256` 后分两次直接写最终文件。并发 refresh 或进程在两次写之间崩溃，可能留下 index 和 checksum 不匹配。

之后 `load_cached_registry()` 会报 `RegistryChecksumMismatch`，即使刚刚写过一个有效 registry。

### 技术细节

当前流程：

1. 序列化 registry cache bytes。
2. 计算 checksum。
3. `fs::write(index_file, bytes)`。
4. `fs::write(checksum_file, checksum)`。

没有 registry-level lock，也没有 temp file + rename。两个文件不是一个原子事务。

### 修复方向

- 增加 registry cache lock，避免并发 refresh 交错写。
- 两个文件都写到临时路径。
- 确保两者都成功后，再 rename 到最终路径。
- 考虑提交顺序：先 index 后 checksum，或者写 manifest 文件合并两者，避免 checksum 指向不存在/旧 index。

### 验证建议

增加 Rust 测试：

- 模拟写 checksum 失败，旧 cache 仍可加载。
- 模拟两个 refresh 交错时不会产生 mismatch。
- 如果难以并发测试，至少抽出 atomic cache commit helper 并注入失败点。

## P2：Windows extension path 被误判为 URL

- 状态：已处理（本次修改，待提交）
- 分类：TypeScript / platform compatibility
- 位置：`src/pi/extension.ts:273-278`

### 现象和影响

`extensionStartUrl()` 用 `^[a-zA-Z][a-zA-Z\d+.-]*:` 判断输入是否已经是 URL。Windows 绝对路径如 `C:\repo\dist\pi\extension.js` 也匹配这个正则，因此会被原样返回，而不是转换成 `file://` URL。

后续 binary resolver 依赖 extension location 推导 native binary root。Windows local install 或开发环境下，这可能导致 bundled/native binary 查找失败。

### 技术细节

URL scheme 和 Windows drive letter 都是 `<letters>:` 形式。当前逻辑没有先判断 Windows absolute path。

`pathToFileURL()` 能正确处理本地路径，但该分支被 URL 正则提前截断。

### 修复方向

- 先识别 Windows absolute path，例如 `/^[a-zA-Z]:[\\/]/`。
- Windows path 必须走 `pathToFileURL(path).href`。
- 只有真正 URL（`file:`, `http:`, `https:` 等）才原样返回。

### 验证建议

增加 Bun 测试：

- ctx extension path 为 `C:\tmp\extension.js`，返回 `file:///C:/tmp/extension.js` 形式。
- `file:///...` 输入仍原样返回。
- POSIX absolute path 仍转 file URL。

## P2：slash command 长操作并发保护启动太晚

- 状态：已处理（本次修改，待提交）
- 分类：Pi panel / concurrency
- 位置：`src/pi/mason-panel.ts:48-55`

### 现象和影响

direct `/mason install|update|uninstall|refresh` 在 custom UI 下会打开 panel，并把初始命令延迟到 component render 后通过 `setTimeout` 执行。`trackLongOperation()` 也在实际运行命令时才调用。

如果用户在首个 panel render 前再次触发 direct long command，第二个 handler 看到 `activeLongOperation` 仍为空，会再打开一个 panel。两个 panel render 后会同时运行 CLI 长操作。

### 技术细节

并发 gate 的生效点太晚：

1. slash handler 调 `openMasonPanel()`。
2. `openMasonPanel()` 设置 `startInitialLoad()`，但实际 command 在 `setTimeout(..., 0)`。
3. handler 返回期间没有占用 `activeLongOperation`。
4. 第二个 handler 可进入同样路径。

### 修复方向

- 在决定打开 direct long-operation panel 时立即 reserve long-operation slot。
- 或让 `openMasonPanel()` 在创建 panel 时同步登记 pending operation，render 后复用该 token。
- 如果 panel 被关闭或 initial load 未执行，需要释放 reservation。

### 验证建议

增加 Bun 测试：

- 连续触发两个 direct install command，不等待 render tick。
- 第二个应被拒绝/提示已有 operation。
- 只有一个 bridge command 被执行。

## P2：Pi `mason_list` tool 允许 conflicting filters

- 状态：已处理（本次修改，待提交）
- 分类：Pi tool schema / argument validation
- 位置：`src/pi/pi-tools.ts:27-31`

### 现象和影响

`mason_list` tool 允许同时传 `installed: true` 和 `outdated: true`，并转发 `list --installed --outdated`。Rust dispatcher 当前优先 installed，outdated 被忽略。调用方原意可能是“列出 outdated packages”，但结果却是所有 installed packages。

slash parser 已经拒绝这种组合，tool API 行为不一致。

### 技术细节

当前 executor：

1. 如果 `installed` true，push `--installed`。
2. 如果 `outdated` true，push `--outdated`。
3. 不做互斥校验。

CLI 的语义实际上是两个不同 list mode，不应同时存在。

### 修复方向

在 tool executor 或 schema validation 后添加：

- 如果 `installed === true && outdated === true`，抛出 validation error。
- 错误消息说明两个参数互斥。
- 保持 missing/false 行为不变。

### 验证建议

增加 `test/pi/pi-tools.test.ts`：

- 同时传 installed/outdated，应 reject。
- 单独 installed -> `list --installed`。
- 单独 outdated -> `list --outdated`。

## P2：TUI refresh tab 不会 invalidate pending run

- 状态：已处理（本次修改，待提交）
- 分类：TUI / async command races
- 位置：`src/tui/mason-tui.ts:615-617`

### 现象和影响

用户切到 refresh tab 时，TUI 只显示确认 prompt，不启动新的 command run，也不递增 command run id。若此前 tab load 仍 pending，旧请求 resolve 后仍可能被视为 current run，覆盖 refresh prompt。

表现为 `state.command` 是 `refresh`，但 UI model 被旧 list/suggested/installed 表格替换。

### 技术细节

普通 command run 使用 `commandRunId` 防 stale result。refresh prompt 不走 `runCurrent()` 的 async path，因此没有 invalidation。

`showRefreshPrompt()` 只是设置 state model/notice；没有使已有 run 失效。

### 修复方向

- 进入 refresh prompt 时递增 `commandRunId` 或调用统一 invalidate helper。
- 所有只改变 UI 且不等待当前 request 的 tab/prompt 切换，都应考虑是否需要 invalidation。

### 验证建议

增加 TUI async 测试：

1. list/suggested run pending。
2. 用户切到 refresh tab。
3. resolve 旧 run。
4. 断言仍显示 refresh prompt，不显示旧 table。

## P2：TUI language/category filter 用 substring 匹配

- 状态：已处理（本次修改，待提交）
- 分类：TUI / filtering
- 位置：`src/tui/mason-tui.ts:1103-1107`

### 现象和影响

language/category picker 提供的是精确选项，但过滤时把 row 中对应列 join/lowercase 后用 `includes()`。选择语言 `C` 会匹配 `TypeScript`、`JavaScript` 这类包含字母 c 的语言。

用户看到 badge `[l C]`，但列表包含非 C package。

### 技术细节

当前逻辑按字符串包含关系过滤，而不是按 cell 中 comma-separated list 的元素匹配。语言和分类都是枚举/列表语义，应拆分后 exact match。

### 修复方向

- 对 language/category cell 按 `,` 拆分。
- trim + lowercase 后与 selected value lowercase 做 equality。
- 不要对整串做 substring includes。

### 验证建议

增加 TUI 测试：

- 构造 package A languages `["C"]`。
- package B languages `["TypeScript"]`。
- 选择 `C` 后只显示 A。
- category 同理覆盖一个包含子串的 case。

## P2：progress result table 只渲染前 8 行

- 状态：已处理（本次修改，待提交）
- 分类：TUI / progress rendering
- 位置：`src/tui/mason-tui.ts:861-863`

### 现象和影响

install/update 完成后，如果 final model 是 table，popup 内调用 `renderDisplay(... maxRows: 8, showHelp: false)`。返回的 line set 已经被截断到 8 行。之后 popup viewport 只能滚动这 8 行，结果中第 9 行及以后永远不可见。

多包 install/update 时用户无法查看完整 operation result。

### 技术细节

滚动应该发生在 popup 层，而不是 table rendering 阶段提前截断。当前把 `maxRows` 传给 inner table renderer，相当于丢弃数据。

### 修复方向

- 渲染 finalModel 时传足够大的 maxRows，例如 rows length 或安全上限。
- 或新增 render mode：不裁剪 table body，只生成完整行集，再由 popup scroll 处理 viewport。
- 注意长 cell wrapping 会让实际 line count 大于 row count。

### 验证建议

增加 TUI 测试：

- 模拟 install 返回 10+ rows。
- 完成后 popup scroll 到底部。
- 断言最后一行 package 可见。

## P2：picker filter 中 Backspace 被提前当作取消

- 状态：已处理（本次修改，待提交）
- 分类：TUI / key handling
- 位置：`src/tui/mason-tui.ts:1229-1232`

### 现象和影响

在 language/category picker 内输入过滤 draft 后，按 Backspace 预期删除最后一个字符。但当前 Backspace 先命中 `isBackKey` 分支，直接取消 filter draft，用户不能在 picker filter 中正常编辑。

### 技术细节

key handling 顺序错误：

1. picker edit 分支先判断 back key。
2. 后面的文本删除逻辑没有机会处理 Backspace。

对 filter draft 状态，应先处理字符编辑，再处理“返回/取消 picker”。

### 修复方向

- 当 `state.edit.filtering === true` 且 key 是 Backspace，优先删除 draft 字符。
- draft 为空时 Backspace 可退出 filtering 或保持现有取消语义。
- Escape/left 等仍可用于取消。

### 验证建议

增加 TUI test：

- 打开 language picker。
- 输入 filter `typ`。
- Backspace 后 draft 变 `ty`，picker 仍处于 filtering。
- Escape 或空 draft Backspace 才取消。

## P2：release 未校验 Cargo/Rust 版本同步

- 状态：已处理（本次修改，待提交）
- 分类：CI / version sync
- 位置：`.github/workflows/release.yml:96-106`

### 现象和影响

release workflow 构建 Rust CLI 后只执行 `mason4agents --version`，但不验证输出值是否等于 Git tag 或 `package.json` version。publish script 的 tag check 也只比较 tag 和 `package.json`。

如果 `crates/mason4agents/Cargo.toml` 或 `Cargo.lock` 版本漂移，npm 包版本可能是 0.2.3，但内置 native CLI 报另一个版本。

### 技术细节

仓库已有 `check:version` script。release path 没有调用它，因此版本同步约束只靠人工。

### 修复方向

- 在 release workflow 构建 native artifacts 前运行 `bun run check:version`。
- 或 smoke test 显式比较 `mason4agents --version` 输出与 `${{ github.ref_name }}` 去掉 `v` 后的版本。

### 验证建议

- 本地运行 `bun run check:version`。
- 修改 Cargo.toml 版本制造 drift，确认 script/workflow step 会失败。

## P2：release 发布排除了 Windows native packages

- 状态：已处理（本次修改，待提交）
- 分类：CI / native packaging
- 位置：`.github/workflows/release.yml:156`

### 现象和影响

release workflow matrix 构建并上传 Windows native artifacts，但 publish step 调用：

```bash
bun scripts/publish.mjs --artifacts release-artifacts --platform non-windows --provenance
```

publish script 会基于 selected native packages 生成 root package 的 `optionalDependencies`。由于 publish 时排除了 Windows，最终 root npm package 不依赖 Windows native package。Windows 用户安装 root package 后 shim 找不到 native CLI。

### 技术细节

构建矩阵和发布选择不一致：CI 花费资源构建 Windows artifact，但发布阶段 deliberately excludes them。除非 Windows support 未完成，否则这是 release artifact 缺失。

### 修复方向

- 如果 Windows 已支持：publish step 改为包含全部平台。
- 如果 Windows 暂不支持：移除 Windows build matrix 和文档承诺，避免发布半支持状态。

### 验证建议

- dry-run `scripts/publish.mjs --artifacts ...`，检查 root manifest `optionalDependencies` 包含 win32-x64/win32-arm64。
- 安装 packed root package，在 Windows resolution test 中确认 native package 可被找到。

## P2：publish 输出目录保护不足

- 状态：已处理（本次修改，待提交）
- 分类：publish script safety
- 位置：`scripts/publish.mjs:454-461`

### 现象和影响

`stagePackages()` 会对 outDir 执行 recursive rm。`assertSafeOutputDirectory()` 只拒绝 `/`、过短路径、以及包含 repo root 的路径。repo 外路径如 `/tmp/mason4agents-output` 或 `/home/kai/releases` 会通过检查并被递归删除。

误传 `--out-dir` 可能删除用户非仓库数据。

### 技术细节

当前 guard 检查的是“outDir 是否包含 repo root”，而不是“outDir 是否位于 repo root 内的预期目录”。这防止了删除 repo 本身，但没有防止删除 repo 外任意目录。

### 修复方向

- 默认只允许 outDir 位于 repo 内，例如 `dist/npm` 下。
- 若确实需要外部 outDir，要求显式 `--allow-external-out-dir` 或环境变量确认。
- 错误信息应显示 resolved path。

### 验证建议

增加 script 单元测试或 Node-level test：

- `--out-dir dist/npm` 通过。
- `--out-dir /tmp/foo` 默认拒绝。
- `--out-dir <repo-parent>` 拒绝。

## P3：OMP defaults cache 每次 sync 都变化

- 状态：待处理
- 分类：OMP defaults / cache sync
- 位置：`src/pi/omp-lsp-defaults.ts:140-145`

### 现象和影响

`buildSuggestionCache()` 每次写入新的 `fetched_at` 时间戳。`syncOmpLspDefaultsCache()` 比较整个 serialized cache 判断是否 changed，因此即使 OMP defaults 内容没有变化，每次 sync 都会重写 cache 并返回 `changed: true`。

这会造成不必要 IO，也会让上层误以为 defaults cache 有实际变化。

### 技术细节

`fetched_at` 是 volatile field，不应参与“内容是否变化”的判断。当前 cache diff 使用整对象/整 JSON 比较，导致 timestamp 变化污染结果。

### 修复方向

- 比较 cache 时忽略 `fetched_at`。
- 只有 rules/source/source_ref/schema 等实际内容变化时才更新时间戳和写文件。
- 或让 `fetched_at` 表示源内容 fetch 时间，仅在源文件 mtime/hash 变化时更新。

### 验证建议

增加 Bun 测试：

- 连续两次 sync 未改变 OMP defaults。
- 第二次返回 `changed: false`。
- cache file mtime/content 不变，或至少除 fetched_at 外内容不变且不重写。

## P3：README 未说明 `register --omp` 只在 npm/Pi shim 可用

- 状态：待处理
- 分类：documentation / command drift
- 位置：`README.md:155-160`

### 现象和影响

README 的 “All CLI Commands” 列出 `mason4agents register --omp`。但 Rust CLI 的 command enum 没有 `register` 子命令；这个命令只由 npm/Pi TypeScript shim 拦截实现。

源码构建用户使用 `target/release/mason4agents register --omp` 会失败，文档没有说明限制。

### 技术细节

同一 README 同时描述源码构建和 npm/Pi shim command，未区分 Rust native CLI surface 与 npm shim augmented command。中文 README 也需要同步，否则 docs parity 破坏。

### 修复方向

二选一：

- 在 Rust CLI 实现 `register --omp`。
- 或在 README/README.zh 中标注该命令仅 npm package/Pi extension shim 可用。

### 验证建议

- 如果实现 Rust CLI：增加 CLI integration test。
- 如果改文档：确认 README.md 和 README.zh.md 结构等价，命令说明一致。

## P3：`pack:local` root tarball 不使用本地 native tarball

- 状态：待处理
- 分类：publish scripts / local packaging
- 位置：`scripts/publish.mjs:125`

### 现象和影响

`pack:local` 会生成 root tarball 和 native package tarballs。但 root manifest 的 `optionalDependencies` 仍是版本号，例如 `mason4agents-linux-x64-gnu: 0.2.3`。本地安装 root tarball 时，npm 会去 registry 解析 native optional dependency，而不是使用 sibling tarball。

如果该版本未发布，本地测试可能没有 native binary；如果已发布，则测试到的是旧 registry binary，不是本次本地构建结果。

### 技术细节

`optionalDependenciesFor(pkg.version, nativePackages)` 只生成 version dependency，没有 pack mode 特判。tarballs 输出目录中已有 native tarball，但 root package 没有引用它们。

### 修复方向

- pack/local mode 下，把 root manifest optionalDependencies 改成 `file:./<native-tarball>` 或可被 npm install 使用的相对路径。
- 或提供并强制文档化本地测试命令：同时安装 root tarball 和 native tarball。

### 验证建议

- 运行 pack local 后检查 root tarball manifest。
- 本地 npm install root tarball，断言 shim 解析到本次生成的 native binary。

## P3：modal popup 背后仍显示普通 footer shortcuts

- 状态：待处理
- 分类：TUI / popup behavior
- 位置：`src/tui/mason-tui.ts:660-663`

### 现象和影响

progress/detail modal 显示时，普通 table footer 已经被追加到底部。modal 没有覆盖 footer，因此用户仍看到 tab/filter/detail/install 等快捷键提示。但 modal 状态下这些按键通常被 `handleProgressInput()` 或 detail handler 消费，实际不会执行 footer 描述的动作。

### 技术细节

render flow 先渲染底层 table 和 footer，再 overlay popup。popup 内容区域不包含底部 footer 行，导致提示混杂。

### 修复方向

- 当 progress/detail/picker modal active 时，隐藏普通 footer。
- 或让 modal 覆盖/替换 footer，只显示 modal-specific actions。

### 验证建议

增加 TUI render test：

- progress popup active 时不显示 normal tab/filter footer。
- detail popup active 时不显示 list install/update footer。
- modal 自己的 close/scroll actions 仍可见。

## P3：picker filter 长文本会截掉右边框

- 状态：待处理
- 分类：TUI / width edge cases
- 位置：`src/tui/mason-tui.ts:914-917`

### 现象和影响

language/category picker filter 行把 raw draft 插入 bordered line 后，再整体 truncate。draft 很长时，truncate 会截断右边框，使 popup 边框破损。

### 技术细节

option/help rows 通常先 fit inner content，再拼接 border；filter draft 行顺序相反：先拼完整字符串，再裁剪整行。

### 修复方向

- 先把 filter draft fit 到 inner width。
- 再拼 `│ ${content} │`。
- 保持右边框永远存在。

### 验证建议

增加 TUI render test：

- 打开 picker filter，输入超过 popup 宽度的字符串。
- 每一行长度不超过 width。
- filter 行仍以右边框结尾。
