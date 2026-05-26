import { MasonCommandInputError, tokenizeMasonArgs } from "../mason-args";
import { errorDisplay, modelForResult, renderDisplay, renderInlineShortcutText, renderShortcutLine, shortcutText, type DisplayModel, type MasonResultKind, type RenderOptions, type RenderStyle, type ShortcutAction } from "./mason-render";

export type MasonTuiCommandId =
  | "search"
  | "list"
  | "suggested"
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

export type MasonTuiEdit =
  | { kind: "name" | "input"; draft: string }
  | { kind: "language" | "category"; options: readonly string[]; selectedIndex: number; scroll: number; filterDraft?: string };

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
  tabSeparator?: (text: string) => string;
  tabMeta?: (text: string) => string;
  divider?: (text: string) => string;
  edit?: (text: string) => string;
  notice?: (text: string) => string;
  popupBorder?: (text: string) => string;
  popupTitle?: (text: string) => string;
  popupBody?: (text: string) => string;
  detailLabel?: (text: string) => string;
  detailValue?: (text: string) => string;
  detailName?: (text: string) => string;
  detailStatus?: (text: string) => string;
  detailActionKey?: (text: string) => string;
  detailAction?: (text: string) => string;
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
  handleInput(...keys: unknown[]): Promise<"close" | void>;
  render(): string;
  renderLines(width: number, style?: MasonTuiStyle): string[];
}

const MASON_TUI_COMMAND_DEFINITIONS: readonly MasonTuiCommand[] = [
  { id: "search", label: "search", inputLabel: "query" },
  { id: "list", label: "list" },
  { id: "suggested", label: "suggested" },
  { id: "installed", label: "installed" },
  { id: "install", label: "install", inputLabel: "packages" },
  { id: "uninstall", label: "uninstall", inputLabel: "packages" },
  { id: "update", label: "check update" },
  { id: "which", label: "which", inputLabel: "executable" },
  { id: "refresh", label: "refresh" },
  { id: "doctor", label: "doctor" },
  { id: "env", label: "env", inputLabel: "shell" },
  { id: "bin-dir", label: "bin-dir" },
];

const HIDDEN_TUI_COMMANDS = new Set<MasonTuiCommandId>(["search", "install", "uninstall", "which", "env", "bin-dir"]);
export const MASON_TUI_COMMANDS: readonly MasonTuiCommand[] = MASON_TUI_COMMAND_DEFINITIONS.filter((command) => !HIDDEN_TUI_COMMANDS.has(command.id));

const SHELLS = new Set(["bash", "zsh", "fish", "powershell", "cmd", "json"]);
const PANEL_MAX_ROWS = 18;
const PANEL_DISPLAY_MIN_LINES = PANEL_MAX_ROWS + 4;
const LIVE_NAME_FILTER_MIN_CHARS = 3;
const PICKER_MAX_ROWS = 10;
const TAB_SEPARATOR = "  ╱  ";

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
    async handleInput(...rawKeys: unknown[]) {
      const key = normalizeInputKey(...rawKeys);
      if (key.length === 0) return;
      if (state.edit) {
        await handleEditKey(state, key, () => tui.runCurrent());
        syncActiveRows(state);
        return;
      }
      if (state.view === "detail" && (isBackKey(key) || isQuitKey(key))) {
        state.view = "list";
        return;
      }
      if (isQuitKey(key)) return "close";
      if (isNextCommandKey(key)) {
        selectCommand(state, state.commandIndex + 1);
        await runSelectedCommand(tui, state);
        return;
      }
      if (isPreviousCommandKey(key)) {
        selectCommand(state, state.commandIndex - 1);
        await runSelectedCommand(tui, state);
        return;
      }
      if (state.command === "refresh" && isRefreshKey(key)) {
        await tui.runCurrent();
        return;
      }
      if (isPackageActionKey(key)) {
        await runPackageAction(state, host, key);
        return;
      }
      if (state.view === "detail") return;
      if (key === "/" && state.model.kind === "table") {
        state.edit = { kind: "name", draft: state.filter };
        return;
      }
      if ((key === "l" || key === "L") && canFilterByLanguage(state)) {
        state.edit = createPickerEdit(state, "language");
        return;
      }
      if ((key === "c" || key === "C") && canFilterByCategory(state)) {
        state.edit = createPickerEdit(state, "category");
        return;
      }
      if (key === "e" && currentCommand(state).inputLabel) {
        state.edit = { kind: "input", draft: state.inputs[state.command] };
        return;
      }
      if (state.view === "list" && state.activeRows.length > 0 && (key === "g" || key === "G")) {
        state.selectedIndex = key === "g" ? 0 : state.activeRows.length - 1;
        state.selectedPackage = selectedPackageName(state);
        ensureSelectionVisible(state);
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
    suggested: "",
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
    case "suggested":
      return { argv: ["suggested"], resultKind: "suggestions", title: "mason suggested" };
    case "installed":
      return { argv: ["list", "--installed"], resultKind: "installed", title: "mason installed" };
    case "install": {
      const packages = splitInput(state.inputs.install);
      if (packages.length === 0) throw new MasonCommandInputError(`install requires package names. ${shortcutText([["[e]", "enter packages"]])}`);
      return { argv: ["install", ...packages], resultKind: "install", title: "mason install", syncAfterPackageChange: true };
    }
    case "uninstall": {
      const packages = splitInput(state.inputs.uninstall);
      if (packages.length === 0) throw new MasonCommandInputError(`uninstall requires package names. ${shortcutText([["[e]", "enter packages"]])}`);
      return { argv: ["uninstall", ...packages], resultKind: "uninstall", title: "mason uninstall", syncAfterPackageChange: true };
    }
    case "update":
      return { argv: ["list", "--outdated"], resultKind: "packages", title: "mason check update" };
    case "which": {
      const executable = splitInput(state.inputs.which);
        if (executable.length !== 1) throw new MasonCommandInputError(`which requires one executable. ${shortcutText([["[e]", "enter executable"]])}`);
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

async function runSelectedCommand(tui: MasonTui, state: MasonTuiState): Promise<MasonTuiState> {
  if (state.command === "refresh") {
    showRefreshPrompt(state);
    return state;
  }
  return tui.runCurrent();
}

function showRefreshPrompt(state: MasonTuiState): void {
  state.view = "list";
  state.loading = false;
  state.edit = undefined;
  state.notice = undefined;
  state.model = { kind: "summary", title: "mason refresh", lines: [shortcutText([["[r]", "refresh registry"]])] };
  state.tableItems = [];
  state.lastTableKind = undefined;
  syncActiveRows(state);
}

function buildSearchInvocation(state: MasonTuiState): MasonTuiInvocation {
  const query = state.inputs.search.trim();
  state.query = query;
  const argv = ["search"];
  if (query.length > 0) argv.push(query);
  if (state.category) argv.push("--category", state.category);
  if (state.language && state.language.trim().length > 0) argv.push("--language", state.language.trim());
  const titleFilters = [
    state.category && state.category.trim().length > 0 ? `category=${state.category.trim()}` : "",
    state.language && state.language.trim().length > 0 ? `language=${state.language.trim()}` : "",
  ].filter((part) => part.length > 0);
  const title = `mason search${query ? ` ${query}` : ""}${titleFilters.length > 0 ? ` ${titleFilters.join(" ")}` : ""}`;
  return { argv, resultKind: "packages", title };
}

export function renderMasonTuiLines(state: MasonTuiState, width: number, style: MasonTuiStyle = {}): string[] {
  const safeWidth = normalizeWidth(width);
  syncActiveRows(state);
  const lines = [
    styleLine(fitToWidth("mason4agents package manager", safeWidth), style.title),
    renderCommandTabs(state, safeWidth, style),
    styleLine("─".repeat(safeWidth), style.divider),
  ];
  if (state.edit && !isPickerEdit(state.edit) && state.edit.kind !== "name") lines.push(styleLine(fitToWidth(`${state.edit.kind}> ${state.edit.draft}`, safeWidth), style.edit));
  if (state.notice) lines.push(renderInlineShortcutText(state.notice, safeWidth, style, style.notice));
  const displayLines = renderCurrentDisplay(state, safeWidth, style);
  lines.push(...padDisplayLines(displayLines, safeWidth, PANEL_DISPLAY_MIN_LINES));
  lines.push(shortcutHelp(state, safeWidth, style));
  const fitted = lines.map((line) => fitToWidth(line, safeWidth));
  if (state.view === "detail") return renderDetailPopup(state, fitted, safeWidth, style);
  return state.edit && isPickerEdit(state.edit) ? renderPickerPopup(state, fitted, safeWidth, style) : fitted;
}

function padDisplayLines(lines: string[], width: number, minLines: number): string[] {
  const padded = [...lines];
  while (padded.length < minLines) padded.push(fitToWidth("", width));
  return padded;
}

function renderCurrentDisplay(state: MasonTuiState, width: number, style: MasonTuiStyle): string[] {
  const baseOptions: RenderOptions = {
    width,
    filterSummary: tableFilterSummary(state),
    filterActions: tableFilterActions(state),
    totalRows: state.model.kind === "table" ? state.model.rows.length : undefined,
    scroll: state.scroll,
    maxRows: PANEL_MAX_ROWS,
    fixedHeight: true,
    showTitle: false,
    showHelp: false,
    style,
  };
  if (state.model.kind === "table" && state.activeRows.length > 0) {
    return renderDisplay(filteredTableModel(state), { ...baseOptions, selectedRow: state.selectedIndex });
  }
  if (state.model.kind === "table") return renderDisplay(filteredTableModel(state), baseOptions);
  return renderDisplay(state.model, baseOptions);
}

function renderDetailContentLines(state: MasonTuiState, width: number, style: MasonTuiStyle): string[] {
  const selected = selectedEntry(state);
  if (!selected) return [fitToWidth("No package selected.", width)];
  const item = recordValue(selected.item);
  const row = selected.row;
  const name = selectedPackageName(state) || "<unknown>";
  const lines = [detailFieldLine(width, "Package", name, style, style.detailName)];
  if (item) {
    pushDetail(lines, width, "Status", packageStatusForDetail(state, item), style, style.detailStatus);
    pushDetail(lines, width, "Reason", stringValue(item.reason) || "-", style);
    pushDetail(lines, width, "Suggested by", stringValue(item.source) || "-", style);
    pushDetail(lines, width, "Version", stringValue(item.version) || "-", style);
    pushDetail(lines, width, "Installed", stringValue(item.installed_version) || (isInstalledPackage(state, item) ? "yes" : "no"), style);
    pushDetail(lines, width, "Languages", stringList(item.languages) || "-", style);
    pushDetail(lines, width, "Categories", stringList(item.categories) || "-", style);
    pushDetail(lines, width, "Description", stringValue(item.description) || "-", style);
    pushDetail(lines, width, "Neovim lspconfig", stringValue(item.neovim_lspconfig) || "-", style);
    pushDetail(lines, width, "Bins", keyList(item.bins) || "-", style);
    pushDetail(lines, width, "Installed at", stringValue(item.installed_at) || "-", style);
    pushDetail(lines, width, "Source", stringValue(item.source_id) || "-", style);
    pushDetail(lines, width, "Package dir", stringValue(item.package_dir) || "-", style);
  } else {
    for (let index = 0; index < row.length; index += 1) pushDetail(lines, width, `Column ${index + 1}`, row[index] ?? "-", style);
  }
  pushActionLines(state, lines, width, style);
  return lines;
}

function renderDetailPopup(state: MasonTuiState, baseLines: string[], width: number, style: MasonTuiStyle): string[] {
  const popupWidth = clamp(Math.floor(width * 0.72), Math.min(44, width), Math.max(1, width - 4));
  const contentWidth = Math.max(1, popupWidth - 4);
  const contentLines = renderDetailContentLines(state, contentWidth, style);
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

function renderPickerPopup(state: MasonTuiState, baseLines: string[], width: number, style: MasonTuiStyle): string[] {
  const edit = state.edit;
  if (!edit || !isPickerEdit(edit)) return baseLines;
  const title = edit.kind === "language" ? " select language " : " select category ";
  const popupWidth = clamp(Math.floor(width * 0.52), Math.min(32, width), Math.max(1, width - 4));
  const contentWidth = Math.max(1, popupWidth - 4);
  const topBorder = `╭${title}${"─".repeat(Math.max(0, popupWidth - title.length - 2))}╮`;
  const bottomBorder = `╰${"─".repeat(Math.max(0, popupWidth - 2))}╯`;

  const active = pickerActiveOptions(edit);
  const optionLines: string[] = [];
  const end = Math.min(active.length, edit.scroll + PICKER_MAX_ROWS);
  for (let displayIdx = edit.scroll; displayIdx < end; displayIdx += 1) {
    const originalIdx = active[displayIdx]!;
    const selected = originalIdx === edit.selectedIndex;
    const marker = selected ? "▶ " : "  ";
    const bodyLine = `│ ${fitToWidth(`${marker}${pickerOptionLabel(edit.kind, edit.options[originalIdx] ?? "")}`, contentWidth)} │`;
    optionLines.push(styleLine(fitToWidth(bodyLine, popupWidth), selected && style.selectedRow ? style.selectedRow : style.popupBody));
  }
  if (optionLines.length === 0) {
    const bodyLine = `│ ${fitToWidth("No options", contentWidth)} │`;
    optionLines.push(styleLine(fitToWidth(bodyLine, popupWidth), style.popupBody));
  }

  const filterDraft = edit.filterDraft;
  const filterLine = filterDraft !== undefined
    ? `│ [/ ${filterDraft}]${" ".repeat(Math.max(0, contentWidth - 5 - (filterDraft ?? "").length))} │`
    : undefined;

  const helpActions: ShortcutAction[] = filterDraft !== undefined
    ? [["[Enter]", "select"], ["[Esc]", "cancel filter"]]
    : [["[Enter]", "select"], ["[/]", "filter"], ["[Esc]", "cancel"]];
  const help = renderShortcutLine("", helpActions, contentWidth, style);

  const popupLines: string[] = [
    styleLine(fitToWidth(topBorder, popupWidth), style.popupBorder),
  ];
  if (filterLine) popupLines.push(styleLine(fitToWidth(filterLine, popupWidth), style.edit));
  popupLines.push(...optionLines);
  popupLines.push(styleLine(fitToWidth(`│ ${fitToWidth(help, contentWidth)} │`, popupWidth), style.popupBody));
  popupLines.push(styleLine(fitToWidth(bottomBorder, popupWidth), style.popupBorder));

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

function pushDetail(lines: string[], width: number, label: string, value: string, style: MasonTuiStyle, valueStyler: ((text: string) => string) | undefined = style.detailValue): void {
  if (value === "-") return;
  lines.push(detailFieldLine(width, label, value, style, valueStyler));
}

function detailFieldLine(width: number, label: string, value: string, style: MasonTuiStyle, valueStyler: ((text: string) => string) | undefined = style.detailValue): string {
  const labelText = `${label}: `;
  const valueWidth = Math.max(1, width - labelText.length);
  const renderedValue = truncateToWidth(value, valueWidth);
  return fitToWidth(`${styleLine(labelText, style.detailLabel)}${styleLine(renderedValue, valueStyler)}`, width);
}

function pushActionLines(state: MasonTuiState, lines: string[], width: number, style: MasonTuiStyle): void {
  const separatorLength = " │ ".length;
  const actions: ShortcutAction[] = [...packageOperationActions(state), ["[q]/[Esc]", "back"]];
  const current: ShortcutAction[] = [];
  let currentLength = 0;
  for (const action of actions) {
    const partLength = action[0].length + 2 + action[1].length;
    const nextLength = current.length === 0 ? partLength : currentLength + separatorLength + partLength;
    if (current.length > 0 && nextLength > width) {
      lines.push(detailActionLine(current, width, style));
      current.length = 0;
      currentLength = 0;
    }
    current.push(action);
    currentLength = currentLength === 0 ? partLength : currentLength + separatorLength + partLength;
  }
  if (current.length > 0) lines.push(detailActionLine(current, width, style));
}

function detailActionLine(actions: readonly (readonly [string, string])[], width: number, style: MasonTuiStyle): string {
  const parts: string[] = [];
  for (const [key, label] of actions) {
    if (parts.length > 0) parts.push(styleLine(" │ ", style.detailAction));
    parts.push(styleLine(key, style.detailActionKey), styleLine(": ", style.detailAction), styleLine(label, style.detailAction));
  }
  return fitToWidth(parts.join(""), width);
}

function renderCommandTabs(state: MasonTuiState, width: number, style: MasonTuiStyle): string {
  const parts: string[] = [];
  const filters = tabFilterBadges(state);
  const meta = width >= 48 ? tabMetaText(state) : "";
  const filterReserve = filterBadgesWidth(filters);
  const tabWidth = Math.max(1, width - filterReserve);
  const compactTabs = tabBarWidth(state, true, meta, filterReserve) <= width && tabBarWidth(state, false, meta, filterReserve) > width;
  let used = 0;
  for (let index = 0; index < MASON_TUI_COMMANDS.length && used < tabWidth; index += 1) {
    const command = MASON_TUI_COMMANDS[index]!;
    if (index > 0 && !pushTabPart(parts, TAB_SEPARATOR, tabWidth, used, style.tabSeparator)) break;
    if (index > 0) used += Math.min(TAB_SEPARATOR.length, tabWidth - used);
    const text = index === state.commandIndex ? `[${command.label}]` : compactTabs ? command.label : ` ${command.label} `;
    if (!pushTabPart(parts, text, tabWidth, used, index === state.commandIndex ? style.activeTab : style.tab)) break;
    used += Math.min(text.length, tabWidth - used);
  }
  if (meta.length > 0 && used < width) {
    const separator = "  │  ";
    if (used + separator.length + meta.length + filterReserve <= width && pushTabPart(parts, separator, width, used, style.tabSeparator)) {
      used += Math.min(separator.length, width - used);
      if (pushTabPart(parts, meta, width, used, style.tabMeta ?? style.tab)) used += Math.min(meta.length, width - used);
    }
  }
  if (filters.length > 0 && used < width) {
    if (parts.length > 0 && pushTabPart(parts, "  ", width, used, style.tabMeta ?? style.tab)) used += Math.min(2, width - used);
    for (let index = 0; index < filters.length && used < width; index += 1) {
      if (index > 0 && pushTabPart(parts, " ", width, used, style.tabMeta ?? style.tab)) used += Math.min(1, width - used);
      const badge = filters[index]!;
      if (!pushTabPart(parts, badge, width, used, style.edit)) break;
      used += Math.min(badge.length, width - used);
    }
  }
  return styleLine(fitToWidth(parts.join(""), width), style.tabBar);
}

function tabBarWidth(state: MasonTuiState, compactTabs: boolean, meta: string, filterReserve: number): number {
  let width = 0;
  for (let index = 0; index < MASON_TUI_COMMANDS.length; index += 1) {
    if (index > 0) width += TAB_SEPARATOR.length;
    const label = MASON_TUI_COMMANDS[index]!.label;
    width += index === state.commandIndex ? label.length + 2 : compactTabs ? label.length : label.length + 2;
  }
  if (meta.length > 0) width += "  │  ".length + meta.length;
  return width + filterReserve;
}

function filterBadgesWidth(filters: readonly string[]): number {
  if (filters.length === 0) return 0;
  return 2 + filters.reduce((sum, filter) => sum + filter.length, 0) + Math.max(0, filters.length - 1);
}

function tabMetaText(state: MasonTuiState): string {
  if (state.model.kind !== "table") return "";
  const shown = state.activeRows.length;
  const total = state.model.rows.length;
  const noun = tableCountNoun(state, total);
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

function tabFilterBadges(state: MasonTuiState): string[] {
  const badges: string[] = [];
  if (state.model.kind !== "table") return badges;
  const name = state.edit?.kind === "name" ? state.edit.draft.trim() : state.filter.trim();
  if (state.edit?.kind === "name") {
    badges.push(name.length > 0 ? `[/ ${name}]` : "[/]");
  } else if (name.length > 0) {
    badges.push(`[/ ${name}]`);
  }
  const language = state.language?.trim();
  if (language && language.length > 0) badges.push(`[l ${language}]`);
  const category = state.category?.trim();
  if (category && category.length > 0) badges.push(`[c ${category}]`);
  return badges;
}

function tableCountNoun(state: MasonTuiState, count: number): string {
  if (state.command === "installed") return "installed";
  if (state.command === "update") return count === 1 ? "update" : "updates";
  if (state.command === "suggested") return count === 1 ? "suggestion" : "suggestions";
  return count === 1 ? "package" : "packages";
}

function pushTabPart(parts: string[], text: string, width: number, used: number, styler: ((text: string) => string) | undefined): boolean {
  const remaining = width - used;
  if (remaining <= 0) return false;
  const clipped = text.length > remaining ? truncateToWidth(text, remaining) : text;
  parts.push(styleLine(clipped, styler));
  return clipped.length === text.length;
}

function updateTableData(state: MasonTuiState, resultKind: MasonResultKind, data: unknown): void {
  if (state.model.kind === "table" && Array.isArray(data)) {
    state.tableItems = data;
    state.lastTableKind = resultKind;
  } else {
    state.tableItems = [];
    state.lastTableKind = undefined;
  }
  if (Array.isArray(data) && (resultKind === "packages" || resultKind === "installed" || resultKind === "suggestions")) state.packages = data;
}

function activeNameFilter(state: MasonTuiState): string {
  const edit = state.edit;
  if (edit?.kind !== "name") return state.filter.trim();
  const draft = edit.draft.trim();
  return draft.length >= LIVE_NAME_FILTER_MIN_CHARS ? draft : "";
}

function syncActiveRows(state: MasonTuiState): void {
  if (state.model.kind !== "table") {
    state.activeRows = [];
    state.activeItems = [];
    state.scroll = 0;
    state.selectedIndex = 0;
    return;
  }
  const nameFilter = activeNameFilter(state).toLocaleLowerCase();
  const languageFilter = (state.language ?? "").trim().toLocaleLowerCase();
  const categoryFilter = (state.category ?? "").trim().toLocaleLowerCase();
  const entries = state.model.rows.map((row, index) => ({ row, item: state.tableItems[index] }));
  const filtered = entries.filter((entry) => {
    if (nameFilter.length > 0 && !packageNameFromItemOrRow(entry.item, entry.row)?.toLocaleLowerCase().includes(nameFilter)) return false;
    if (languageFilter.length > 0 && !languagesFromItemOrRow(entry.item, entry.row).toLocaleLowerCase().includes(languageFilter)) return false;
    if (categoryFilter.length > 0 && !categoriesFromItemOrRow(entry.item, entry.row).toLocaleLowerCase().includes(categoryFilter)) return false;
    return true;
  });
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
  const len = state.activeRows.length;
  if (len === 0) return;
  state.view = "list";
  state.selectedIndex = ((state.selectedIndex + delta) % len + len) % len;
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

function resetListCursor(state: MasonTuiState): void {
  state.scroll = 0;
  state.selectedIndex = 0;
  state.selectedPackage = undefined;
  state.view = "list";
}

async function handleEditKey(state: MasonTuiState, key: string, runCurrent: () => Promise<MasonTuiState>): Promise<MasonTuiState | void> {
  const edit = state.edit;
  if (!edit) return;
  if (isPickerEdit(edit)) {
    handlePickerEditKey(state, edit, key);
    return;
  }
  if (isEnterKey(key)) {
    const draft = edit.draft.trim();
    if (edit.kind === "name") {
      state.filter = draft;
      resetListCursor(state);
      state.edit = undefined;
      return;
    }
    state.inputs[state.command] = draft;
    if (state.command === "search") state.query = draft;
    resetListCursor(state);
    state.edit = undefined;
    return runCurrent();
  }
  if (key === "\b" || key === "\x7f" || key === "backspace") {
    edit.draft = edit.draft.slice(0, -1);
    if (edit.kind === "name") resetListCursor(state);
    return;
  }
  if (isBackKey(key)) {
    state.edit = undefined;
    return;
  }
  if (key.length === 1 && key >= " ") {
    edit.draft += key;
    if (edit.kind === "name") resetListCursor(state);
  }
}

function handlePickerEditKey(state: MasonTuiState, edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>, key: string): void {
  if (edit.filterDraft !== undefined) {
    handlePickerFilterKey(state, edit, key);
    return;
  }
  if (isEnterKey(key)) {
    commitPickerSelection(state, edit);
    return;
  }
  if (isBackKey(key)) {
    state.edit = undefined;
    return;
  }
  if (key === "/") {
    edit.filterDraft = "";
    return;
  }
  if (key === "g") {
    edit.selectedIndex = 0;
    ensurePickerSelectionVisible(edit);
    return;
  }
  if (key === "G") {
    const active = pickerActiveOptions(edit);
    if (active.length > 0) edit.selectedIndex = active[active.length - 1]!;
    ensurePickerSelectionVisible(edit);
    return;
  }
  if (isScrollDownKey(key)) { movePickerSelection(edit, 1); return; }
  if (isScrollUpKey(key)) { movePickerSelection(edit, -1); return; }
  if (isPageDownKey(key)) { movePickerSelection(edit, PICKER_MAX_ROWS); return; }
  if (isPageUpKey(key)) { movePickerSelection(edit, -PICKER_MAX_ROWS); }
}

function handlePickerFilterKey(state: MasonTuiState, edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>, key: string): void {
  if (isEnterKey(key)) {
    commitPickerFilterSelection(state, edit);
    return;
  }
  if (isBackKey(key)) {
    delete edit.filterDraft;
    selectFirstPickerOption(edit);
    return;
  }
  if (key === "/") {
    delete edit.filterDraft;
    selectFirstPickerOption(edit);
    return;
  }
  if (key === "\b" || key === "\x7f" || key === "backspace") {
    edit.filterDraft = (edit.filterDraft ?? "").slice(0, -1);
    if ((edit.filterDraft ?? "").trim().length < LIVE_NAME_FILTER_MIN_CHARS) {
      delete edit.filterDraft;
      selectFirstPickerOption(edit);
    } else {
      selectFirstPickerOption(edit);
    }
    return;
  }
  if (isScrollDownKey(key)) { movePickerSelection(edit, 1); return; }
  if (isScrollUpKey(key)) { movePickerSelection(edit, -1); return; }
  if (isPageDownKey(key)) { movePickerSelection(edit, PICKER_MAX_ROWS); return; }
  if (isPageUpKey(key)) { movePickerSelection(edit, -PICKER_MAX_ROWS); return; }
  if (key.length === 1 && key >= " ") {
    edit.filterDraft = (edit.filterDraft ?? "") + key;
    if (edit.filterDraft.trim().length >= LIVE_NAME_FILTER_MIN_CHARS) selectFirstPickerOption(edit);
  }
}

function selectFirstPickerOption(edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>): void {
  const active = pickerActiveOptions(edit);
  edit.selectedIndex = active.length > 0 ? active[0]! : 0;
  edit.scroll = 0;
}

function commitPickerSelection(state: MasonTuiState, edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>): void {
  const value = edit.options[edit.selectedIndex] ?? "";
  if (edit.kind === "language") {
    state.language = value.length > 0 ? value : undefined;
  } else {
    state.category = value.length > 0 ? value : undefined;
  }
  resetListCursor(state);
  state.edit = undefined;
}

function commitPickerFilterSelection(state: MasonTuiState, edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>): void {
  const active = pickerActiveOptions(edit);
  delete edit.filterDraft;
  if (active.length === 0) {
    resetListCursor(state);
    state.edit = undefined;
    return;
  }
  if (!active.includes(edit.selectedIndex)) edit.selectedIndex = active[0]!;
  commitPickerSelection(state, edit);
}

function pickerActiveOptions(edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>): number[] {
  const draft = edit.filterDraft?.trim() ?? "";
  if (draft.length < LIVE_NAME_FILTER_MIN_CHARS) return edit.options.map((_, i) => i);
  const filter = draft.toLocaleLowerCase();
  const result: number[] = [];
  for (let i = 0; i < edit.options.length; i++) {
    const text = edit.options[i] ?? "";
    if (text.toLocaleLowerCase().includes(filter)) result.push(i);
  }
  return result;
}

function movePickerSelection(edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>, delta: number): void {
  const active = pickerActiveOptions(edit);
  if (active.length === 0) return;
  const pos = active.indexOf(edit.selectedIndex);
  const newPos = pos >= 0 ? ((pos + delta) % active.length + active.length) % active.length : 0;
  edit.selectedIndex = active[newPos]!;
  ensurePickerSelectionVisible(edit);
}

function ensurePickerSelectionVisible(edit: Extract<MasonTuiEdit, { kind: "language" | "category" }>): void {
  const active = pickerActiveOptions(edit);
  const maxScroll = Math.max(0, active.length - PICKER_MAX_ROWS);
  const pos = active.indexOf(edit.selectedIndex);
  if (pos < 0) { edit.scroll = 0; return; }
  if (pos < edit.scroll) edit.scroll = pos;
  if (pos >= edit.scroll + PICKER_MAX_ROWS) edit.scroll = pos - PICKER_MAX_ROWS + 1;
  edit.scroll = clamp(edit.scroll, 0, maxScroll);
}

function isPickerEdit(edit: MasonTuiEdit): edit is Extract<MasonTuiEdit, { kind: "language" | "category" }> {
  return edit.kind === "language" || edit.kind === "category";
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
      setNotice(state, host, `${name} is already installed. ${shortcutText([["[u]", "update"]])}`, "error");
      return;
    }
    await runPackageCommand(state, host, ["install", name], name, "Installed");
    return;
  }
  if (key === "u" || key === "U") {
    if (!installed) {
      setNotice(state, host, `${name} is not installed. ${shortcutText([["[i]", "install"]])}`, "error");
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
  if (state.command === "search" || state.command === "list" || state.command === "suggested" || state.command === "installed" || state.command === "update") {
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
  state.language = undefined;
  state.category = undefined;
}

function currentCommand(state: MasonTuiState): MasonTuiCommand {
  return MASON_TUI_COMMAND_DEFINITIONS.find((command) => command.id === state.command) ?? MASON_TUI_COMMANDS[state.commandIndex]!;
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

function languagesFromItemOrRow(item: unknown, row: readonly string[]): string {
  return listValuesFromItemOrRow(item, row, "languages", 4).join(",");
}

function categoriesFromItemOrRow(item: unknown, row: readonly string[]): string {
  return listValuesFromItemOrRow(item, row, "categories", 5).join(",");
}

function listValuesFromItemOrRow(item: unknown, row: readonly string[], property: "languages" | "categories", columnIndex: number): string[] {
  const value = recordValue(item);
  const values = value ? stringValues(value[property]) : [];
  if (values.length > 0) return values;
  return splitListCell(row[columnIndex]);
}

function createPickerEdit(state: MasonTuiState, kind: "language" | "category"): Extract<MasonTuiEdit, { kind: "language" | "category" }> {
  const options = pickerOptions(state, kind);
  const current = (kind === "language" ? state.language : state.category) ?? "";
  const selectedIndex = Math.max(0, options.indexOf(current));
  const edit: Extract<MasonTuiEdit, { kind: "language" | "category" }> = { kind, options, selectedIndex, scroll: 0 };
  ensurePickerSelectionVisible(edit);
  return edit;
}

function pickerOptions(state: MasonTuiState, kind: "language" | "category"): readonly string[] {
  if (state.model.kind !== "table") return [""];
  const seen = new Set<string>();
  const candidates: string[] = [];
  const property = kind === "language" ? "languages" : "categories";
  const columnIndex = kind === "language" ? 4 : 5;
  for (let index = 0; index < state.model.rows.length; index += 1) {
    for (const value of listValuesFromItemOrRow(state.tableItems[index], state.model.rows[index]!, property, columnIndex)) {
      if (seen.has(value)) continue;
      seen.add(value);
      candidates.push(value);
    }
  }
  const current = (kind === "language" ? state.language : state.category) ?? "";
  if (current.length > 0 && !seen.has(current)) candidates.push(current);
  candidates.sort((left, right) => left.localeCompare(right));
  return ["", ...candidates];
}

function pickerOptionLabel(kind: "language" | "category", value: string): string {
  if (value.length > 0) return value;
  return kind === "language" ? "All languages" : "All categories";
}

function filteredTableModel(state: MasonTuiState): DisplayModel {
  if (state.model.kind !== "table") return state.model;
  return {
    ...state.model,
    rows: state.activeRows,
  };
}

function tableFilterSummary(state: MasonTuiState): string | undefined {
  const filterParts: string[] = [];
  const nameFilter = activeNameFilter(state);
  if (nameFilter.length > 0) filterParts.push(`name: ${nameFilter}`);
  if (state.language && state.language.trim().length > 0) filterParts.push(`language: ${state.language.trim()}`);
  if (state.category && state.category.trim().length > 0) filterParts.push(`category: ${state.category.trim()}`);
  return filterParts.length > 0 ? filterParts.join("  ") : undefined;
}

function shortcutHelp(state: MasonTuiState, width: number, style: MasonTuiStyle): string {
  return renderShortcutLine("", [...browseHelpActions(state, width), ...actionHelpActions(state, width)], width, style);
}

function actionHelpActions(state: MasonTuiState, width: number): ShortcutAction[] {
  if (state.edit) return isPickerEdit(state.edit) ? [["[Enter]", "select"], ["[Esc]", "cancel"]] : [["[Enter]", "apply"], ["[Esc]", "cancel"], ["[Backspace]", "delete"]];
  if (state.command === "refresh") return [["[r]", "refresh registry"], ["[q]/[Esc]", "close"]];
  if (state.model.kind === "table") {
    return [["[Enter]", "detail"], ...packageOperationActions(state)];
  }
  return [["[Enter]", "run"], ["[q]/[Esc]", "close"]];
}

function packageOperationActions(state: MasonTuiState): ShortcutAction[] {
  const selected = selectedEntryWithoutSync(state);
  if (!selected || !packageNameFromItemOrRow(selected.item, selected.row)) return [];
  const item = recordValue(selected.item);
  return isInstalledPackage(state, item) ? [["[u]", "update"], ["[r]", "uninstall"]] : [["[i]", "install"]];
}

function browseHelpActions(state: MasonTuiState, width: number): ShortcutAction[] {
  if (width < 100 && state.model.kind === "table" && !state.edit) {
    return [[`[Tab/S-Tab/←→]/[↑↓/Pg]/${compactFilterKeys(state)}`, "browse"]];
  }
  const actions: ShortcutAction[] = [["[Tab/S-Tab/←→]", "tabs"]];
  if (state.edit) return actions;
  if (state.model.kind === "table") actions.push(["[↑↓/Pg]", "move"], ...tableFilterActions(state));
  if (currentCommand(state).inputLabel) actions.push(["[e]", "edit"]);
  return actions;
}

function tableFilterActions(state: MasonTuiState): ShortcutAction[] {
  const actions: ShortcutAction[] = [["[/]", "name"]];
  if (canFilterByLanguage(state)) actions.push(["[l]", "lang"]);
  if (canFilterByCategory(state)) actions.push(["[c]", "cat"]);
  return actions;
}

function compactFilterKeys(state: MasonTuiState): string {
  const keys = ["[/]"];
  if (canFilterByLanguage(state)) keys.push("[l]");
  if (canFilterByCategory(state)) keys.push("[c]");
  return keys.join("/");
}

function canFilterByLanguage(state: MasonTuiState): boolean {
  return state.model.kind === "table" && state.model.columns.some((column) => column.label === "Languages");
}

function canFilterByCategory(state: MasonTuiState): boolean {
  return state.model.kind === "table" && state.model.columns.some((column) => column.label === "Categories");
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
  if (state.command === "suggested") return "suggested";
  return "available";
}

function isPackageActionKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase();
  return normalized === "i" || normalized === "u" || normalized === "r";
}

function isQuitKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase();
  return normalized === "q" || key === "\x03" || normalized === "ctrl+c" || normalized === "ctrl-c";
}

function isBackKey(key: string): boolean {
  if (isEscapeKey(key) || key === "\b" || key === "\x7f") return true;
  const normalized = key.toLocaleLowerCase();
  return normalized === "escape" || normalized === "esc" || normalized === "backspace";
}

function isEnterKey(key: string): boolean {
  return key === "\r" || key === "\n" || key === "enter" || key === "return";
}

function isNextCommandKey(key: string): boolean {
  if (isPlainTabKey(key) || key === "\x1b[C") return true;
  const normalized = key.toLocaleLowerCase();
  return normalized === "tab" || normalized === "right" || normalized === "arrowright";
}

function isPreviousCommandKey(key: string): boolean {
  if (isShiftTabKey(key) || key === "\x1b[D") return true;
  const normalized = key.toLocaleLowerCase();
  return normalized === "shift+tab" || normalized === "shift-tab" || normalized === "shift_tab" || normalized === "shifttab" || normalized === "backtab" || normalized === "back-tab" || normalized === "back_tab" || normalized === "s-tab" || normalized === "s+tab" || normalized === "left" || normalized === "arrowleft";
}

function isRefreshKey(key: string): boolean {
  return key.toLocaleLowerCase() === "r";
}

function isScrollDownKey(key: string): boolean {
  if (key === "\x1b[B") return true;
  const normalized = key.toLocaleLowerCase();
  return normalized === "down" || normalized === "arrowdown" || normalized === "j";
}

function isScrollUpKey(key: string): boolean {
  if (key === "\x1b[A") return true;
  const normalized = key.toLocaleLowerCase();
  return normalized === "up" || normalized === "arrowup" || normalized === "k";
}

function isPageDownKey(key: string): boolean {
  return key.toLocaleLowerCase() === "pagedown" || key === "\x1b[6~";
}

function isPageUpKey(key: string): boolean {
  return key.toLocaleLowerCase() === "pageup" || key === "\x1b[5~";
}

function normalizeInputKey(...inputs: unknown[]): string {
  const candidates = inputs.flatMap(inputKeyCandidates);
  const shiftedTab = candidates.find((key) => isPreviousCommandKey(key) && !isNextCommandKey(key));
  if (shiftedTab) return shiftedTab;
  return candidates[0] ?? "";
}

function inputKeyCandidates(input: unknown): string[] {
  if (typeof input === "string") {
    const normalized = normalizeKeyString(input);
    return normalized.length > 0 ? [normalized] : [];
  }
  const record = recordValue(input);
  if (!record) return [];
  const candidates: string[] = [];
  const name = stringValue(record.name) || stringValue(record.key) || stringValue(record.code);
  const sequence = stringValue(record.sequence) || stringValue(record.input);
  const normalizedSequence = sequence.length > 0 ? normalizeKeyString(sequence) : "";
  if (normalizedSequence.length > 0) candidates.push(normalizedSequence);
  if (name.length > 0) {
    const normalized = normalizeKeyString(name);
    const shifted = record.shift === true || record.shiftKey === true;
    if (shifted && (normalized === "tab" || normalized === "\t")) {
      candidates.unshift("shift-tab");
    } else {
      candidates.push(normalized);
    }
  }
  return candidates.filter((candidate) => candidate.length > 0);
}

function normalizeKeyString(key: string): string {
  if (key.length === 1 || key.startsWith("\x1b")) return key;
  const normalized = key.toLocaleLowerCase();
  if (normalized === "escape") return "escape";
  if (normalized === "arrowleft") return "left";
  if (normalized === "arrowright") return "right";
  if (normalized === "arrowup") return "up";
  if (normalized === "arrowdown") return "down";
  if (normalized === "return") return "enter";
  return normalized;
}

function isEscapeKey(data: string): boolean {
  return data === "\x1b" || matchesTerminalKey(data, 27, 0);
}

function isPlainTabKey(data: string): boolean {
  return data === "\t" || matchesTerminalKey(data, 9, 0);
}

function isShiftTabKey(data: string): boolean {
  return data === "\x1b[Z" || matchesTerminalKey(data, 9, 1);
}

function matchesTerminalKey(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
  return matchesCsiUKey(data, expectedCodepoint, expectedModifier) || matchesModifyOtherKeys(data, expectedCodepoint, expectedModifier);
}

function matchesCsiUKey(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
  const match = data.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/);
  if (!match) return false;
  const codepoint = Number.parseInt(match[1]!, 10);
  const modifier = match[2] ? Number.parseInt(match[2], 10) - 1 : 0;
  return codepoint === expectedCodepoint && stripLockModifiers(modifier) === expectedModifier;
}

function matchesModifyOtherKeys(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return false;
  const modifier = Number.parseInt(match[1]!, 10) - 1;
  const codepoint = Number.parseInt(match[2]!, 10);
  return codepoint === expectedCodepoint && stripLockModifiers(modifier) === expectedModifier;
}

function stripLockModifiers(modifier: number): number {
  return modifier & ~(64 + 128);
}

function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return 80;
  return Math.max(1, Math.floor(width));
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(value) <= width) return value;
  if (stripAnsi(value).length !== value.length) return truncateAnsiToWidth(value, width);
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, width - 1)}…`;
}

function truncateAnsiToWidth(value: string, width: number): string {
  let visible = 0;
  let output = "";
  for (let index = 0; index < value.length && visible < width;) {
    if (value[index] === "\x1b") {
      const sequence = value.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (sequence) {
        output += sequence[0];
        index += sequence[0].length;
        continue;
      }
    }
    output += value[index]!;
    index += 1;
    visible += 1;
  }
  return output.includes("\x1b") ? `${output}\x1b[0m` : output;
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
  return stringValues(value).join(",");
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const item of value) {
      const text = stringValue(item).trim();
      if (text.length > 0) result.push(text);
    }
    return result;
  }
  return typeof value === "string" ? splitListCell(value) : [];
}

function splitListCell(value: string | undefined): string[] {
  if (!value) return [];
  const result: string[] = [];
  for (const item of value.split(",")) {
    const text = item.trim();
    if (text.length > 0) result.push(text);
  }
  return result;
}

function keyList(value: unknown): string {
  const record = recordValue(value);
  return record ? Object.keys(record).join(",") : "";
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
