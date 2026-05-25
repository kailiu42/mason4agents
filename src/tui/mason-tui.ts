import { MasonCommandInputError, tokenizeMasonArgs } from "../mason-args";
import { errorDisplay, modelForResult, renderDisplay, type DisplayModel, type MasonResultKind, type RenderOptions, type RenderStyle } from "./mason-render";

export type MasonTuiCommandId =
  | "search"
  | "list"
  | "installed"
  | "install"
  | "uninstall"
  | "update"
  | "which"
  | "refresh"
  | "doctor"
  | "env"
  | "bin-dir";

export interface MasonTuiCommand {
  id: MasonTuiCommandId;
  label: string;
  inputLabel?: string;
}

export interface MasonTuiEdit {
  kind: "filter" | "language" | "input";
  draft: string;
}

export type MasonTuiView = "list" | "detail";

export interface MasonTuiState {
  command: MasonTuiCommandId;
  commandIndex: number;
  view: MasonTuiView;
  query: string;
  category: string | undefined;
  language: string | undefined;
  inputs: Record<MasonTuiCommandId, string>;
  filter: string;
  scroll: number;
  selectedIndex: number;
  selectedPackage: string | undefined;
  loading: boolean;
  edit: MasonTuiEdit | undefined;
  model: DisplayModel;
  packages: unknown[];
  tableItems: unknown[];
  activeRows: readonly (readonly string[])[];
  activeItems: readonly unknown[];
  lastTableKind: MasonResultKind | undefined;
  lastAction?: unknown;
  notice: string | undefined;
}

export interface MasonTuiHost {
  runCli(args: string[]): Promise<unknown>;
  syncAfterPackageChange?: () => unknown;
  notify?: (message: string, level?: "info" | "error") => unknown;
}

export interface MasonTuiStyle extends RenderStyle {
  title?: (text: string) => string;
  tabBar?: (text: string) => string;
  tab?: (text: string) => string;
  activeTab?: (text: string) => string;
  stateLine?: (text: string) => string;
  divider?: (text: string) => string;
  edit?: (text: string) => string;
  notice?: (text: string) => string;
  popupBorder?: (text: string) => string;
  popupTitle?: (text: string) => string;
  popupBody?: (text: string) => string;
}

export interface MasonTui {
  title: string;
  state: MasonTuiState;
  refresh(): Promise<MasonTuiState>;
  search(query?: string, filters?: { category: string | undefined; language: string | undefined }): Promise<MasonTuiState>;
  install(packages: string[]): Promise<MasonTuiState>;
  uninstall(packages: string[]): Promise<MasonTuiState>;
  update(packages?: string[]): Promise<MasonTuiState>;
  doctor(): Promise<MasonTuiState>;
  runCurrent(): Promise<MasonTuiState>;
  handleInput(key: string): Promise<"close" | void>;
  render(): string;
  renderLines(width: number, style?: MasonTuiStyle): string[];
}

export const MASON_TUI_COMMANDS: readonly MasonTuiCommand[] = [
  { id: "search", label: "search", inputLabel: "query" },
  { id: "list", label: "list" },
  { id: "installed", label: "installed" },
  { id: "install", label: "install", inputLabel: "packages" },
  { id: "uninstall", label: "uninstall", inputLabel: "packages" },
  { id: "update", label: "update", inputLabel: "packages" },
  { id: "which", label: "which", inputLabel: "executable" },
  { id: "refresh", label: "refresh" },
  { id: "doctor", label: "doctor" },
  { id: "env", label: "env", inputLabel: "shell" },
  { id: "bin-dir", label: "bin-dir" },
];

const SHELLS = new Set(["bash", "zsh", "fish", "powershell", "cmd", "json"]);
const PANEL_MAX_ROWS = 18;
const PANEL_DISPLAY_MIN_LINES = PANEL_MAX_ROWS + 4;

export function createMasonTui(host: MasonTuiHost): MasonTui {
  const state: MasonTuiState = {
    command: "list",
    commandIndex: commandIndex("list"),
    view: "list",
    query: "",
    category: undefined,
    language: undefined,
    inputs: initialInputs(),
    filter: "",
    scroll: 0,
    selectedIndex: 0,
    selectedPackage: undefined,
    loading: false,
    edit: undefined,
    model: modelForResult("packages", [], "mason list"),
    packages: [],
    tableItems: [],
    activeRows: [],
    activeItems: [],
    lastTableKind: "packages",
    notice: undefined,
  };
  let commandRunId = 0;

  function nextCommandRunId(): number {
    commandRunId += 1;
    return commandRunId;
  }

  function isCurrentCommandRun(runId: number): boolean {
    return runId === commandRunId;
  }

  async function execute(planned: MasonTuiInvocation, preservePackage: string | undefined = undefined): Promise<MasonTuiState> {
    const runId = nextCommandRunId();
    state.loading = true;
    state.view = "list";
    state.model = { kind: "summary", title: planned.title, lines: ["Loading..."] };
    syncActiveRows(state);
    try {
      const data = await host.runCli(planned.argv);
      if (!isCurrentCommandRun(runId)) return state;
      state.lastAction = data;
      if (planned.syncAfterPackageChange) host.syncAfterPackageChange?.();
      state.model = modelForResult(planned.resultKind, data, planned.title);
      updateTableData(state, planned.resultKind, data);
      if (preservePackage !== undefined) state.selectedPackage = preservePackage;
    } catch (err) {
      if (!isCurrentCommandRun(runId)) return state;
      state.model = errorDisplay(planned.title, messageFromError(err));
      state.tableItems = [];
      state.lastTableKind = undefined;
    } finally {
      if (isCurrentCommandRun(runId)) {
        state.loading = false;
        syncActiveRows(state);
      }
    }
    return state;
  }

  const tui: MasonTui = {
    title: "mason4agents",
    state,
    async refresh() {
      const refreshResult = await host.runCli(["refresh"]);
      state.lastAction = refreshResult;
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async search(query = "", filters: { category: string | undefined; language: string | undefined } = { category: undefined, language: undefined }) {
      state.commandIndex = commandIndex("search");
      state.command = "search";
      state.view = "list";
      state.query = query;
      state.inputs.search = query;
      state.category = filters.category;
      state.language = filters.language;
      resetSelection(state);
      return execute(buildSearchInvocation(state));
    },
    async install(packages: string[]) {
      state.lastAction = await host.runCli(["install", ...packages]);
      host.syncAfterPackageChange?.();
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async uninstall(packages: string[]) {
      state.lastAction = await host.runCli(["uninstall", ...packages]);
      host.syncAfterPackageChange?.();
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async update(packages: string[] = []) {
      state.lastAction = await host.runCli(["update", ...packages]);
      host.syncAfterPackageChange?.();
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async doctor() {
      state.commandIndex = commandIndex("doctor");
      state.command = "doctor";
      resetSelection(state);
      return execute({ argv: ["doctor"], resultKind: "doctor", title: "mason doctor" });
    },
    async runCurrent() {
      try {
        return await execute(buildInvocation(state));
      } catch (err) {
        nextCommandRunId();
        state.model = errorDisplay("mason4agents", messageFromError(err));
        state.tableItems = [];
        state.loading = false;
        syncActiveRows(state);
        return state;
      }
    },
    async handleInput(key: string) {
      if (state.edit) {
        await handleEditKey(state, key, () => tui.runCurrent());
        syncActiveRows(state);
        return;
      }
      if (isQuitKey(key)) return "close";
      if (isNextCommandKey(key)) {
        selectCommand(state, state.commandIndex + 1);
        await tui.runCurrent();
        return;
      }
      if (isPreviousCommandKey(key)) {
        selectCommand(state, state.commandIndex - 1);
        await tui.runCurrent();
        return;
      }
      if (state.view === "detail" && isBackKey(key)) {
        state.view = "list";
        return;
      }
      if (isPackageActionKey(key)) {
        await runPackageAction(state, host, key);
        return;
      }
      if (state.view === "detail") return;
      if (key === "/") {
        state.edit = { kind: "filter", draft: state.filter };
        return;
      }
      if ((key === "l" || key === "L") && state.command === "search") {
        state.edit = { kind: "language", draft: state.language ?? "" };
        return;
      }
      if (key === "e" && currentCommand(state).inputLabel) {
        state.edit = { kind: "input", draft: state.inputs[state.command] };
        return;
      }
      if (isScrollDownKey(key)) {
        moveSelection(state, 1);
        return;
      }
      if (isScrollUpKey(key)) {
        moveSelection(state, -1);
        return;
      }
      if (isPageDownKey(key)) {
        moveSelection(state, PANEL_MAX_ROWS);
        return;
      }
      if (isPageUpKey(key)) {
        moveSelection(state, -PANEL_MAX_ROWS);
        return;
      }
      if (isEnterKey(key)) {
        syncActiveRows(state);
        if (state.model.kind === "table" && state.activeRows.length > 0) {
          state.view = "detail";
          state.notice = undefined;
          return;
        }
        await tui.runCurrent();
        return;
      }
      if (isBackKey(key)) return "close";
    },
    render() {
      return renderMasonTuiLines(state, 120).map((line) => line.trimEnd()).join("\n");
    },
    renderLines(width: number, style?: MasonTuiStyle) {
      return renderMasonTuiLines(state, width, style);
    },
  };

  syncActiveRows(state);
  return tui;
}

interface MasonTuiInvocation {
  argv: string[];
  resultKind: MasonResultKind;
  title: string;
  syncAfterPackageChange?: boolean;
}

function initialInputs(): Record<MasonTuiCommandId, string> {
  return {
    search: "",
    list: "",
    installed: "",
    install: "",
    uninstall: "",
    update: "",
    which: "",
    refresh: "",
    doctor: "",
    env: "bash",
    "bin-dir": "",
  };
}

function buildInvocation(state: MasonTuiState): MasonTuiInvocation {
  switch (state.command) {
    case "search":
      return buildSearchInvocation(state);
    case "list":
      return { argv: ["list"], resultKind: "packages", title: "mason list" };
    case "installed":
      return { argv: ["list", "--installed"], resultKind: "installed", title: "mason installed" };
    case "install": {
      const packages = splitInput(state.inputs.install);
      if (packages.length === 0) throw new MasonCommandInputError("install requires package names. Press e to enter packages.");
      return { argv: ["install", ...packages], resultKind: "install", title: "mason install", syncAfterPackageChange: true };
    }
    case "uninstall": {
      const packages = splitInput(state.inputs.uninstall);
      if (packages.length === 0) throw new MasonCommandInputError("uninstall requires package names. Press e to enter packages.");
      return { argv: ["uninstall", ...packages], resultKind: "uninstall", title: "mason uninstall", syncAfterPackageChange: true };
    }
    case "update":
      return { argv: ["update", ...splitInput(state.inputs.update)], resultKind: "install", title: "mason update", syncAfterPackageChange: true };
    case "which": {
      const executable = splitInput(state.inputs.which);
      if (executable.length !== 1) throw new MasonCommandInputError("which requires one executable. Press e to enter it.");
      return { argv: ["which", executable[0]!], resultKind: "which", title: `mason which ${executable[0]!}` };
    }
    case "refresh":
      return { argv: ["refresh"], resultKind: "refresh", title: "mason refresh" };
    case "doctor":
      return { argv: ["doctor"], resultKind: "doctor", title: "mason doctor" };
    case "env": {
      const shell = state.inputs.env.trim() || "bash";
      if (!SHELLS.has(shell)) throw new MasonCommandInputError("env shell must be one of bash, zsh, fish, powershell, cmd, json.");
      return { argv: ["env", "--shell", shell], resultKind: "env", title: `mason env --shell ${shell}` };
    }
    case "bin-dir":
      return { argv: ["bin-dir"], resultKind: "bin-dir", title: "mason bin-dir" };
  }
}

function buildSearchInvocation(state: MasonTuiState): MasonTuiInvocation {
  const query = state.inputs.search.trim();
  state.query = query;
  const argv = ["search"];
  if (query.length > 0) argv.push(query);
  if (state.category) argv.push("--category", state.category);
  if (state.language && state.language.trim().length > 0) argv.push("--language", state.language.trim());
  const title = state.language && state.language.trim().length > 0 ? `mason search${query ? ` ${query}` : ""} language=${state.language.trim()}` : `mason search${query ? ` ${query}` : ""}`;
  return { argv, resultKind: "packages", title };
}

export function renderMasonTuiLines(state: MasonTuiState, width: number, style: MasonTuiStyle = {}): string[] {
  const safeWidth = normalizeWidth(width);
  syncActiveRows(state);
  const lines = [
    styleLine(fitToWidth("mason4agents package manager", safeWidth), style.title),
    renderCommandTabs(state, safeWidth, style),
    styleLine(fitToWidth(renderStateLine(state), safeWidth), style.stateLine),
    styleLine("─".repeat(safeWidth), style.divider),
  ];
  if (state.edit) lines.push(styleLine(fitToWidth(`${state.edit.kind}> ${state.edit.draft}`, safeWidth), style.edit));
  if (state.notice) lines.push(styleLine(fitToWidth(state.notice, safeWidth), style.notice));
  const displayLines = renderCurrentDisplay(state, safeWidth, style);
  lines.push(...padDisplayLines(displayLines, safeWidth, PANEL_DISPLAY_MIN_LINES));
  lines.push(styleLine(fitToWidth("Keys: Tab/←/→ tabs  ↑/↓ select  Enter detail/run  i install  u update  r uninstall  / filter  e edit  q close", safeWidth), style.help));
  const fitted = lines.map((line) => fitToWidth(line, safeWidth));
  return state.view === "detail" ? renderDetailPopup(state, fitted, safeWidth, style) : fitted;
}

function padDisplayLines(lines: string[], width: number, minLines: number): string[] {
  const padded = [...lines];
  while (padded.length < minLines) padded.push(fitToWidth("", width));
  return padded;
}

function renderCurrentDisplay(state: MasonTuiState, width: number, style: MasonTuiStyle): string[] {
  const baseOptions: RenderOptions = { width, filter: state.filter, scroll: state.scroll, maxRows: PANEL_MAX_ROWS, fixedHeight: true, style };
  if (state.model.kind === "table" && state.activeRows.length > 0) {
    return renderDisplay(state.model, { ...baseOptions, selectedRow: state.selectedIndex });
  }
  return renderDisplay(state.model, baseOptions);
}

function renderDetailContentLines(state: MasonTuiState, width: number): string[] {
  const selected = selectedEntry(state);
  if (!selected) return [fitToWidth("No package selected.", width)];
  const item = recordValue(selected.item);
  const row = selected.row;
  const name = selectedPackageName(state) || "<unknown>";
  const lines = [fitToWidth(`Package: ${name}`, width)];
  if (item) {
    pushDetail(lines, width, "Status", packageStatusForDetail(state, item));
    pushDetail(lines, width, "Version", stringValue(item.version) || "-");
    pushDetail(lines, width, "Installed", stringValue(item.installed_version) || (isInstalledPackage(state, item) ? "yes" : "no"));
    pushDetail(lines, width, "Languages", stringList(item.languages) || "-");
    pushDetail(lines, width, "Categories", stringList(item.categories) || "-");
    pushDetail(lines, width, "Description", stringValue(item.description) || "-");
    pushDetail(lines, width, "Neovim lspconfig", stringValue(item.neovim_lspconfig) || "-");
    pushDetail(lines, width, "Bins", keyList(item.bins) || "-");
    pushDetail(lines, width, "Installed at", stringValue(item.installed_at) || "-");
    pushDetail(lines, width, "Source", stringValue(item.source_id) || "-");
    pushDetail(lines, width, "Package dir", stringValue(item.package_dir) || "-");
  } else {
    for (let index = 0; index < row.length; index += 1) pushDetail(lines, width, `Column ${index + 1}`, row[index] ?? "-");
  }
  lines.push(fitToWidth("Actions: i install  u update  r uninstall  Esc/Backspace back", width));
  return lines;
}

function renderDetailPopup(state: MasonTuiState, baseLines: string[], width: number, style: MasonTuiStyle): string[] {
  const popupWidth = clamp(Math.floor(width * 0.72), Math.min(44, width), Math.max(1, width - 4));
  const contentWidth = Math.max(1, popupWidth - 4);
  const contentLines = renderDetailContentLines(state, contentWidth);
  const title = " package details ";
  const topBorder = `╭${title}${"─".repeat(Math.max(0, popupWidth - title.length - 2))}╮`;
  const bottomBorder = `╰${"─".repeat(Math.max(0, popupWidth - 2))}╯`;
  const popupLines = [
    styleLine(fitToWidth(topBorder, popupWidth), style.popupBorder),
    ...contentLines.map((line, index) => {
      const bodyLine = `│ ${fitToWidth(line.trimEnd(), contentWidth)} │`;
      return styleLine(fitToWidth(bodyLine, popupWidth), index === 0 ? style.popupTitle ?? style.popupBody : style.popupBody);
    }),
    styleLine(fitToWidth(bottomBorder, popupWidth), style.popupBorder),
  ];
  const top = Math.max(3, Math.floor((baseLines.length - popupLines.length) / 2));
  const left = Math.max(0, Math.floor((width - popupWidth) / 2));
  const result = [...baseLines];
  for (let index = 0; index < popupLines.length; index += 1) {
    const target = top + index;
    if (target >= result.length) result.push(fitToWidth("", width));
    result[target] = fitToWidth(`${" ".repeat(left)}${popupLines[index]!}`, width);
  }
  return result.map((line) => fitToWidth(line, width));
}

function pushDetail(lines: string[], width: number, label: string, value: string): void {
  if (value === "-") return;
  lines.push(fitToWidth(`${label}: ${value}`, width));
}

function renderCommandTabs(state: MasonTuiState, width: number, style: MasonTuiStyle): string {
  const parts: string[] = [];
  let used = 0;
  for (let index = 0; index < MASON_TUI_COMMANDS.length && used < width; index += 1) {
    const command = MASON_TUI_COMMANDS[index]!;
    const text = index === state.commandIndex ? `[${command.label}]` : ` ${command.label} `;
    const segment = `${index === 0 ? "" : " "}${text}`;
    const clipped = segment.length > width - used ? truncateToWidth(segment, width - used) : segment;
    parts.push(styleLine(clipped, index === state.commandIndex ? style.activeTab : style.tab));
    used += clipped.length;
    if (clipped.length < segment.length) break;
  }
  const tabs = parts.join("");
  return styleLine(fitToWidth(tabs, width), style.tabBar);
}

function renderStateLine(state: MasonTuiState): string {
  const command = currentCommand(state);
  const parts = [`command=${command.label}`, `view=${state.view}`];
  if (command.inputLabel) {
    const value = state.inputs[state.command];
    parts.push(`${command.inputLabel}=${value.length > 0 ? value : "-"}`);
  }
  if (state.command === "search") parts.push(`language=${state.language && state.language.length > 0 ? state.language : "-"}`);
  if (state.filter.length > 0) parts.push(`filter=${state.filter}`);
  if (state.model.kind === "table") parts.push(`selected=${state.activeRows.length > 0 ? state.selectedIndex + 1 : 0}/${state.activeRows.length}`);
  if (state.loading) parts.push("loading");
  return parts.join("  ");
}

function updateTableData(state: MasonTuiState, resultKind: MasonResultKind, data: unknown): void {
  if (state.model.kind === "table" && Array.isArray(data)) {
    state.tableItems = data;
    state.lastTableKind = resultKind;
  } else {
    state.tableItems = [];
    state.lastTableKind = undefined;
  }
  if (Array.isArray(data) && (resultKind === "packages" || resultKind === "installed")) state.packages = data;
}

function syncActiveRows(state: MasonTuiState): void {
  if (state.model.kind !== "table") {
    state.activeRows = [];
    state.activeItems = [];
    state.scroll = 0;
    state.selectedIndex = 0;
    return;
  }
  const filter = state.filter.trim().toLocaleLowerCase();
  const entries = state.model.rows.map((row, index) => ({ row, item: state.tableItems[index] }));
  const filtered = filter.length === 0 ? entries : entries.filter((entry) => entry.row.join(" ").toLocaleLowerCase().includes(filter));
  state.activeRows = filtered.map((entry) => entry.row);
  state.activeItems = filtered.map((entry) => entry.item);
  if (state.selectedPackage !== undefined) {
    const selectedByName = filtered.findIndex((entry) => packageNameFromItemOrRow(entry.item, entry.row) === state.selectedPackage);
    if (selectedByName >= 0) state.selectedIndex = selectedByName;
  }
  state.selectedIndex = clamp(state.selectedIndex, 0, Math.max(0, filtered.length - 1));
  ensureSelectionVisible(state);
  const selected = selectedPackageName(state);
  if (selected !== undefined) state.selectedPackage = selected;
}

function moveSelection(state: MasonTuiState, delta: number): void {
  syncActiveRows(state);
  if (state.activeRows.length === 0) return;
  state.view = "list";
  state.selectedIndex = clamp(state.selectedIndex + delta, 0, state.activeRows.length - 1);
  state.selectedPackage = selectedPackageName(state);
  ensureSelectionVisible(state);
}

function ensureSelectionVisible(state: MasonTuiState): void {
  const maxScroll = Math.max(0, state.activeRows.length - PANEL_MAX_ROWS);
  if (state.selectedIndex < state.scroll) state.scroll = state.selectedIndex;
  if (state.selectedIndex >= state.scroll + PANEL_MAX_ROWS) state.scroll = state.selectedIndex - PANEL_MAX_ROWS + 1;
  state.scroll = clamp(state.scroll, 0, maxScroll);
}

function resetSelection(state: MasonTuiState): void {
  state.filter = "";
  state.scroll = 0;
  state.selectedIndex = 0;
  state.selectedPackage = undefined;
  state.edit = undefined;
  state.notice = undefined;
}

async function handleEditKey(state: MasonTuiState, key: string, runCurrent: () => Promise<MasonTuiState>): Promise<MasonTuiState | void> {
  const edit = state.edit;
  if (!edit) return;
  if (isEnterKey(key)) {
    const draft = edit.draft.trim();
    if (edit.kind === "filter") {
      state.filter = draft;
      state.scroll = 0;
      state.selectedIndex = 0;
      state.selectedPackage = undefined;
      state.view = "list";
      state.edit = undefined;
      return;
    }
    if (edit.kind === "language") {
      state.language = draft.length > 0 ? draft : undefined;
      state.scroll = 0;
      state.selectedIndex = 0;
      state.selectedPackage = undefined;
      state.view = "list";
      state.edit = undefined;
      return runCurrent();
    }
    state.inputs[state.command] = draft;
    if (state.command === "search") state.query = draft;
    state.scroll = 0;
    state.selectedIndex = 0;
    state.selectedPackage = undefined;
    state.view = "list";
    state.edit = undefined;
    return runCurrent();
  }
  if (key === "\b" || key === "\x7f" || key === "backspace") {
    edit.draft = edit.draft.slice(0, -1);
    return;
  }
  if (isBackKey(key)) {
    state.edit = undefined;
    return;
  }
  if (key.length === 1 && key >= " ") edit.draft += key;
}

async function runPackageAction(state: MasonTuiState, host: MasonTuiHost, key: string): Promise<void> {
  syncActiveRows(state);
  const name = selectedPackageName(state);
  const selected = selectedEntry(state);
  if (!name || !selected) {
    setNotice(state, host, "No package selected.", "error");
    return;
  }
  const item = recordValue(selected.item);
  const installed = isInstalledPackage(state, item);
  if (key === "i" || key === "I") {
    if (installed) {
      setNotice(state, host, `${name} is already installed. Press u to update.`, "error");
      return;
    }
    await runPackageCommand(state, host, ["install", name], name, "Installed");
    return;
  }
  if (key === "u" || key === "U") {
    if (!installed) {
      setNotice(state, host, `${name} is not installed. Press i to install.`, "error");
      return;
    }
    await runPackageCommand(state, host, ["update", name], name, "Updated");
    return;
  }
  if (!installed) {
    setNotice(state, host, `${name} is not installed.`, "error");
    return;
  }
  await runPackageCommand(state, host, ["uninstall", name], name, "Uninstalled");
}

async function runPackageCommand(state: MasonTuiState, host: MasonTuiHost, argv: string[], packageName: string, pastTense: string): Promise<void> {
  state.loading = true;
  state.notice = `${argv[0]} ${packageName}...`;
  try {
    state.lastAction = await host.runCli(argv);
    host.syncAfterPackageChange?.();
    await refreshAfterPackageChange(state, host, packageName);
    setNotice(state, host, `${pastTense} ${packageName}.`, "info");
  } catch (err) {
    const message = messageFromError(err);
    state.model = errorDisplay(`mason ${argv[0]}`, message);
    state.tableItems = [];
    setNotice(state, host, message, "error");
  } finally {
    state.loading = false;
    syncActiveRows(state);
  }
}

async function refreshAfterPackageChange(state: MasonTuiState, host: MasonTuiHost, packageName: string): Promise<void> {
  state.selectedPackage = packageName;
  if (state.command === "search" || state.command === "list" || state.command === "installed") {
    const planned = buildInvocation(state);
    state.model = { kind: "summary", title: planned.title, lines: ["Loading..."] };
    const data = await host.runCli(planned.argv);
    state.lastAction = data;
    state.model = modelForResult(planned.resultKind, data, planned.title);
    updateTableData(state, planned.resultKind, data);
    syncActiveRows(state);
    return;
  }
  state.commandIndex = commandIndex("search");
  state.command = "search";
  state.inputs.search = state.query;
  const planned = buildSearchInvocation(state);
  const data = await host.runCli(planned.argv);
  state.lastAction = data;
  state.model = modelForResult(planned.resultKind, data, planned.title);
  updateTableData(state, planned.resultKind, data);
  syncActiveRows(state);
}

function setNotice(state: MasonTuiState, host: MasonTuiHost, message: string, level: "info" | "error"): void {
  state.notice = message;
  host.notify?.(message, level);
}

function selectCommand(state: MasonTuiState, nextIndex: number): void {
  const count = MASON_TUI_COMMANDS.length;
  state.commandIndex = ((nextIndex % count) + count) % count;
  state.command = MASON_TUI_COMMANDS[state.commandIndex]!.id;
  state.view = "list";
  resetSelection(state);
}

function currentCommand(state: MasonTuiState): MasonTuiCommand {
  return MASON_TUI_COMMANDS[state.commandIndex]!;
}

function commandIndex(command: MasonTuiCommandId): number {
  const index = MASON_TUI_COMMANDS.findIndex((item) => item.id === command);
  return index >= 0 ? index : 0;
}

function splitInput(input: string): string[] {
  return tokenizeMasonArgs(input.trim());
}

function selectedEntry(state: MasonTuiState): { row: readonly string[]; item: unknown } | undefined {
  syncActiveRows(state);
  const row = state.activeRows[state.selectedIndex];
  if (!row) return undefined;
  return { row, item: state.activeItems[state.selectedIndex] };
}

function selectedPackageName(state: MasonTuiState): string | undefined {
  const selected = selectedEntryWithoutSync(state);
  if (!selected) return undefined;
  return packageNameFromItemOrRow(selected.item, selected.row);
}

function selectedEntryWithoutSync(state: MasonTuiState): { row: readonly string[]; item: unknown } | undefined {
  const row = state.activeRows[state.selectedIndex];
  if (!row) return undefined;
  return { row, item: state.activeItems[state.selectedIndex] };
}

function packageNameFromItemOrRow(item: unknown, row: readonly string[]): string | undefined {
  const value = recordValue(item);
  const name = value ? stringValue(value.name) || stringValue(value.package) : "";
  if (name.length > 0) return name;
  const firstCell = row[0];
  return firstCell && firstCell.length > 0 ? firstCell : undefined;
}

function isInstalledPackage(state: MasonTuiState, item: Record<string, unknown> | undefined): boolean {
  if (state.command === "installed") return true;
  if (!item) return false;
  if (item.installed === true) return true;
  return stringValue(item.installed_version).length > 0;
}

function packageStatusForDetail(state: MasonTuiState, item: Record<string, unknown>): string {
  if (item.deprecated === true) return "deprecated";
  const installed = isInstalledPackage(state, item);
  if (installed && item.outdated === true) return "outdated";
  if (installed) return "installed";
  return "available";
}

function isPackageActionKey(key: string): boolean {
  return key === "i" || key === "I" || key === "u" || key === "U" || key === "r" || key === "R";
}

function isQuitKey(key: string): boolean {
  return key === "q" || key === "\x03" || key === "ctrl+c" || key === "ctrl-c";
}

function isBackKey(key: string): boolean {
  return key === "\x1b" || key === "escape" || key === "esc" || key === "backspace" || key === "\b" || key === "\x7f";
}

function isEnterKey(key: string): boolean {
  return key === "\r" || key === "\n" || key === "enter" || key === "return";
}

function isNextCommandKey(key: string): boolean {
  return key === "tab" || key === "\t" || key === "right" || key === "\x1b[C";
}

function isPreviousCommandKey(key: string): boolean {
  return key === "shift+tab" || key === "backtab" || key === "\x1b[Z" || key === "left" || key === "\x1b[D";
}

function isScrollDownKey(key: string): boolean {
  return key === "down" || key === "j" || key === "\x1b[B";
}

function isScrollUpKey(key: string): boolean {
  return key === "up" || key === "k" || key === "\x1b[A";
}

function isPageDownKey(key: string): boolean {
  return key === "pagedown" || key === "\x1b[6~";
}

function isPageUpKey(key: string): boolean {
  return key === "pageup" || key === "\x1b[5~";
}

function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return 80;
  return Math.max(1, Math.floor(width));
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(value) <= width) return value;
  if (stripAnsi(value).length !== value.length) return value;
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, width - 1)}…`;
}

function fitToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  const visible = visibleLength(truncated);
  if (visible >= width) return truncated;
  return truncated + " ".repeat(width - visible);
}

function styleLine(value: string, styler: ((text: string) => string) | undefined): string {
  return styler ? styler(value) : value;
}

const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, "");
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(stringValue).filter((item) => item.length > 0).join(",");
}

function keyList(value: unknown): string {
  const record = recordValue(value);
  return record ? Object.keys(record).join(",") : "";
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
