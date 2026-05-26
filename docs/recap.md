# Problems & Solutions

- **CLI output mode moved across ownership boundaries**: Changing the CLI to
  emit human-readable text by default and JSON only with `--json` originally
  moved `Cli` into `run(cli)` before the caller could read `cli.json`. The fix
  was to detect `--json` from raw args before parsing and make `run` return an
  `Output { json, text }` struct, avoiding a broad `Clone` derivation across the
  clap command tree.
- **Dependency-ordered commits had to start from an empty baseline**: The
  project had no baseline commit, so everything was untracked. `git add -N`
  gave diff visibility before staging, and the first layers temporarily reduced
  manifest/export surface so core primitives and runtime code could be verified
  independently before later layers restored the full bin target and exports.
- **`/mason` command silently produced no output**: The handler tried to call
  `sendUserMessage` on the command context, but that method belongs to the
  ExtensionAPI object. Capturing `pi` from `activate(ctx)` and using it for
  message dispatch fixed the direct command path.
- **PATH mutation during extension load could hang Pi**:
  `ensureMasonBinOnPath()` modified `process.env.PATH` inside the extension
  factory, which caused jiti module resolution to loop during boot. The fix was
  to compute the bin dir read-only during activation and defer PATH mutation to
  the `session_start` deferred handler.
- **TUI state changes did not refresh on screen**: Pi custom components are
  pull-rendered, so mutating closure state inside `handleInput` is invisible
  unless the component explicitly invalidates. Every state-mutating input path
  now requests a TUI render and guards fake/null TUI objects in tests.
- **Untracked files were missed during review**: `git diff --stat` only covered
  tracked files, so new source/test files were invisible. Review workflows must
  pair diff inspection with `git status --short`.
- **Fresh environments without a Rust toolchain failed verification**:
  `bun run verify`, builds, and publish commands depend on `cargo test`, so a
  default Rust toolchain is required. Installing stable with a minimal rustup
  profile resolved the fresh-machine failure.
- **npm package metadata did not match binary packaging behavior**: The publish
  script packaged only the current-platform binary, but `package.json` did not
  restrict `os` or `cpu`. Unsupported platforms would install successfully and
  fail later at binary resolution; package metadata must match the native binary
  coverage actually shipped.
- **Direct slash commands could hang on custom UI overlays**:
  `/mason-doctor` and non-empty `/mason` subcommands opened `ui.custom()` panels
  whose completion callback never fired for direct commands. Publishing inline
  messages instead of opening a blocking overlay fixed those command paths.
- **OMP-loaded extensions could not resolve their packaged native binary**:
  OMP mirrors legacy extension files into `/tmp` before import, so
  `import.meta.url` pointed at the mirror instead of the real plugin directory.
  The resolver now receives `ctx.extension.resolvedPath` and walks ancestors
  from the real extension path.
- **OMP startup LSP discovery needed absolute config, not only PATH**:
  `rust-analyzer` could run from interactive shells after extension PATH
  injection, but OMP builds the startup LSP list before `session_start`. The
  robust fix was to sync OMP-readable `lsp.json` during activation and after
  package-changing actions, using absolute commands from the Mason bin dir and
  only writing entries for LSP-capable packages.
- **Git-rule compliance regressed during history edits**: Commit message line
  length and `Signed-off-by` rules drifted while rewriting commits. Treat commit
  messages as testable artifacts: write them to a temp file, run the checker,
  commit with `-s -F`, and validate the final message from `git log`.
- **`/mason` TUI needed a host-aware boundary**: Width, theming, and detail
  navigation were mixed into the Pi adapter. Moving neutral list/detail behavior
  into `src/tui/`, keeping Pi-specific overlay/theme mapping in
  `src/pi/mason-panel.ts`, and rendering details as an in-place popup made the
  boundary cleaner.
- **`/mason` showed Pi's working row when built-ins did not**: Extension slash
  commands went through Pi's session command path and showed the loader. Local
  `/mason` and `/mason-doctor` handlers now hide the working indicator while
  running and restore it in `finally`.
- **The TUI shifted under real interaction**: Host width constraints, visible
  row-dependent columns, and sparse command pages changed the canvas during use.
  The fix was to request a full-width overlay, compute table widths from the
  filtered data set, wrap cells inside columns, and pad all command views to a
  stable height.
- **Fast tab switching could show stale command output**: Older CLI requests
  could return after newer tab changes and overwrite state. A monotonically
  increasing command run id now ensures only the latest request updates the TUI.
- **`/mason` startup was slow for two separate reasons**: Initial listing hit
  registry work, and the panel also started CLI work before the first frame.
  The fix was to start cache-first, refresh explicitly or when no cache exists,
  begin CLI work after first render, and request both TUI and component
  invalidation when data returns.
- **Commit-message checking used an ambiguous shared path**: The checker lived
  in a symlinked external instruction repo, so repo-root lookup missed it. The
  corrected rule resolves `scripts/check-commit-message.sh` relative to
  `.coding-agent-instructions/git/git-commit-rules.md`.

- **`/mason` filter state spans input, picker, and list views**: Name,
  language, and category filters originally behaved differently: slash input
  committed only on Enter, picker filters could close the input without applying
  the choice, and active constraints were easy to miss. The fix was to separate
  draft filters from committed filters, apply live filtering only after three
  characters, make picker Enter select the highlighted filtered candidate, and
  keep all active filters visible as highlighted tab-row badges.
- **Inline filter badges can disappear if appended like width-limited tabs**:
  Reusing the width-aware tab-part appender for `[/]` meant narrow layouts could
  consume all width before the active filter marker was added. Appending filter
  badges unconditionally and letting the final row fitting truncate the whole
  line preserves the higher-priority status signal.
- **A requested UI document was claimed before it existed**: The UI guideline
  write-up had to be verified with a file lookup, not assumed from prose. The
  recovery was to check for `docs/UI.md`, write the missing file, and commit it
  separately after validating the worktree state.

- **OMP compatibility should drive LSP recommendations, not editor popularity alone**:
  Recommending LazyVim's `vtsls` surfaced that OMP only treats built-in servers as
  partial overrides; non-built-in servers need a full `ServerConfig`. The fix was
  to inspect OMP `lsp/config.ts` and `defaults.json`, cache the built-in list in
  the plugin, prefer those server keys for recommendations, and only fall back to
  LazyVim when OMP has no built-in LSP for that language.
- **Duplicate LSP registrations came from mixing Mason aliases with OMP built-in
  keys**: `rust_analyzer`/`ts_ls` appeared alongside
  `rust-analyzer`/`typescript-language-server` because registry
  `neovim.lspconfig` names were emitted even when the Mason package name already
  matched an OMP built-in server key. The fix was to resolve server identity by
  preferring the OMP built-in key first and only using registry aliases for
  non-built-in servers.

# Valuable Findings

- **Layered commits enable targeted validation**: Splitting work into core
  primitives, installer runtime, CLI, Pi adapter, and docs let each layer use a
  focused verification gate before being committed.
- **Interrupted reviewer runs can still surface real issues**: Even a failed
  parallel review flagged useful follow-up areas, including XDG/HOME fallback
  logic, HTTP vs local-path classification, state-save atomicity, Mason schema
  compatibility, and registry cache recovery.
- **Behavioral probes beat code archaeology for Pi bugs**: The command dispatch
  and PATH hang issues were found through `console.error` probes and
  binary-search experiments, while extensive Pi internals reading produced no
  actionable fix.
- **Bun build output is not transparent to Pi by default**: `bun build --target
  bun` can emit loader-sensitive wrappers and named default exports. Raw JS
  files with `export default function` are safer for extension entry points.
- **PTY-based smoke tests catch TUI gaps that unit tests miss**: Fake bridge
  tests passed while real Pi sessions exposed render-cycle and width issues.
  A small PTY smoke script was the decisive verification gate.
- **Pi custom component rendering is host scheduled**: Components mutate local
  state, but the host decides when to call `render(width)`. State changes need
  explicit invalidation, resize handling, and focus-aware redraws.
- **`npm pack --dry-run --json` enables package-content validation**: Parsing
  the dry-run output lets the publish driver assert that the JS entry points,
  native binary, and package metadata are present before `npm publish`.
- **Reviewers must follow script references across diff boundaries**: A script
  invoked from `package.json` is part of the behavior contract even when the
  script file itself is untracked or not included in the visible diff.
- **OMP mirrors plugin files before importing them**: Runtime path resolution in
  extensions cannot assume `import.meta.url` points inside the installed
  package; use the original resolved extension path supplied by the host.
- **Startup discovery evidence must be separated from interactive evidence**:
  A tool working in an interactive shell proves only post-startup environment
  state. Startup features need source/config inspection or a reproduction that
  exercises the actual boot sequence.
- **Absolute paths are the safer contract for startup tool discovery**: For LSP,
  DAP, or runner discovery initialized before extension events, concrete config
  with absolute commands avoids shell ordering and environment propagation
  ambiguity.
- **OMP LSP behavior had to be inferred from source and runtime evidence**:
  Inspecting startup flow and deleting/regenerating config explained why the
  host-readable file should be `lsp.json` and why only LSP-capable packages
  should be written there.
- **Pi theming belongs at the adapter edge**: Theme tokens such as
  `selectedBg`, `customMessageBg`, `toolTitle`, `borderAccent`, and `muted`
  should be mapped in the Pi adapter, not leaked into neutral TUI logic.
- **ANSI styling must be applied after table layout**: Escape sequences break
  naive width checks. Compute and truncate plain cells first, style full lines
  afterward, and strip ANSI SGR sequences in tests when checking visible width.
- **Terminal UI bugs need explicit layout invariants**: Useful invariants are
  that rendered lines fit the supplied width, headers and separators remain
  stable while scrolling, and all command views return the same canvas height.
- **Commit-message rules should be executable checks**: Line length, body
  presence, Conventional Commit shape, and sign-off coverage are easier to keep
  correct when validated before and after commit creation.
- **Fast CLI output does not prove a fast TUI update**: In Pi custom UI, data
  can return quickly while the screen remains on `Loading...` if the component
  did not receive a valid render request.
- **Shared instruction files need self-relative executable references**:
  Symlinked instruction directories work across repos when examples resolve
  sibling scripts from the instruction file directory instead of assuming a
  repo-root helper path.

- **Filter UX needs one state model across views**: Main-list search and
  language/category picker filtering are easier to reason about when each view
  has an explicit draft state, a committed state, and a single function that
  derives the active visible rows or candidates.
- **Status visibility is part of the behavior contract**: A filter that works
  but is not visible after the popup closes is still a UI bug. Tests should
  assert not only filtered rows, but also durable status badges such as
  `[/ query]`, `[l Language]`, and `[c Category]`.
- **TypeScript optional-property exactness catches UI-state ambiguity**:
  `exactOptionalPropertyTypes` rejected assigning `undefined` to optional picker
  filter drafts, forcing the code to use `delete` when leaving filter mode. That
  made "filter draft absent" distinct from "filter draft is an empty string".
- **Concrete package names in tests can imply false special-casing**: Using real
  Mason package names and languages helped test recognizable behavior, but also
  made dynamic registry-driven logic look hard-coded. Neutral fixtures better
  communicate that production code derives options from package data.

- **OMP exposes no extension API for default LSP discovery**: The extension host
  provides commands, tools, messages, UI, and session hooks, but nothing like
  `getDefaultLspServers()`. The reliable source of default support is
  `packages/coding-agent/src/lsp/defaults.json`; `loadConfig()` is runtime
  filtered by cwd, root markers, binaries, and user overrides, so it is not a
  substitute for the built-in list.
- **OMP merges built-in servers but validates custom servers from scratch**:
  Built-ins can be overridden with only a `command`, because OMP merges them with
  `defaults.json`. New servers are discarded unless `command`, `fileTypes`, and
  `rootMarkers` are all present. That explains why
  `typescript-language-server` worked immediately while `vtsls` needed a full
  generated config.
- **Repeated source inspection beats guessing host behavior from one working
  server**: Seeing `typescript-language-server` load did not prove `vtsls` was
  supported. Comparing OMP source, generated `lsp.json`, and actual startup
  behavior revealed the exact built-in/custom split and the alias collision.

# Things To Avoid

- **Do not derive broad traits to work around ownership**: Deriving `Clone` on
  the clap command tree hides the real output-mode boundary and spreads trait
  requirements across the command enum.
- **Do not mix module boundaries in one commit**: Core primitives, installer
  runtime, CLI behavior, Pi integration, and docs should stay in separate
  layers so verification and review remain precise.
- **Do not delegate chained subagent retries without a kill switch**: Parallel
  investigations need clear success/failure gates and a maximum retry count.
- **Do not run Pi tests from the project directory without `--no-extensions`**:
  The `package.json` extension manifest can auto-load the built artifact and
  register a second extension instance alongside the test extension.
- **Do not hide a needed TUI handle behind `_tui`**: The parameter may be needed
  later for `requestRender(true)` or invalidation, so keep it accessible even if
  the first version does not use it.
- **Do not assume 54-column terminals are representative**: Narrow split panes
  can drop table columns below roughly 55 columns, so table rendering needs
  tests across small and normal widths.
- **Do not ship current-platform-only binaries in an unconstrained npm package**:
  If only one native binary is built, constrain `os` and `cpu` so unsupported
  installs fail clearly instead of failing at runtime.
- **Do not invoke the publish driver with Node when Bun is the guaranteed
  runtime**: Use Bun for publish scripts if the project otherwise only promises
  Bun availability.
- **Do not use `import.meta.url` as the filesystem anchor for OMP-loaded
  extensions**: The import URL may point to a temp mirror, cache path, or
  rewritten file URL.
- **Do not rely solely on PATH injection for startup-visible tools**: Any host
  feature initialized during session creation should use pre-start config or
  absolute paths.
- **Do not debug startup discovery only from an interactive command pane**:
  Separate "can execute now" from "was discoverable during boot" and inspect the
  startup sequence directly.
- **Do not assume installer/link success proves host discovery success**:
  Executable permissions and symlinks can be correct while the host's startup
  discovery layer still misses the tool.
- **Do not commit before re-reading changed repository rules**: Instruction
  drift can invalidate otherwise good commits; validate messages mechanically
  after reading the current rules.
- **Do not let Pi or OMP APIs leak into the neutral TUI core**: Host-specific
  UI, theme, notification, and working-indicator behavior belongs in adapters.
- **Do not treat unit-level `handleInput()` success as proof of real TUI
  behavior**: Keyboard state can pass while the host still fails to redraw, uses
  the wrong width, or handles escape differently.
- **Do not calculate column layout only from visible rows**: Scrolling or moving
  selection will resize columns if long values outside the viewport are ignored.
- **Do not run `git commit` from long inline `-m` bodies**: Use a temp message
  file, run the checker, commit with `-s -F`, and validate the final message.
- **Do not start expensive work before the first custom UI render**: Even
  un-awaited async work can synchronously resolve binaries or spawn processes
  before the overlay appears.
- **Do not treat a missing repo-root script as proof that a checker is absent**:
  For shared symlinked instructions, resolve referenced scripts relative to the
  instruction file's directory.
- **Do not hide active filters only in table titles or transient popups**:
  Once a name/language/category filter is applied, keep it visible in the main
  tab row so users can understand why the list is constrained.
- **Do not make Enter semantics differ between filtered picker and unfiltered
  picker modes**: In both cases Enter should apply the highlighted candidate and
  return to the list, not merely dismiss the filter input.
- **Do not let layout helpers silently drop high-priority status text**:
  Width-aware appenders are useful for tab labels, but active filter badges must
  be added before final fitting so narrow screens truncate predictably instead
  of losing the filter indicator entirely.
- **Do not claim a documentation deliverable was written without checking the
  filesystem**: For docs tasks, verify the target file exists and inspect status
  before reporting completion or committing.
- **Do not use Mason registry `neovim.lspconfig` aliases as unconditional OMP
  server keys**: A Mason package can already correspond to an OMP built-in under
  a different canonical key. Emitting both creates duplicate registrations and
  misleading generated metadata.
- **Do not assume a visible `command` entry in `lsp.json` means OMP will load the
  server**: For non-built-in servers, missing `fileTypes` or `rootMarkers` causes
  OMP to reject the entry during normalization even though the JSON file itself
  looks plausible.
