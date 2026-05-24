import type { CliBridge } from "./cli";
import { MasonCommandInputError, tokenizeMasonArgs } from "./mason-command";
import { errorDisplay, modelForResult, renderDisplay, type DisplayModel, type MasonResultKind } from "./mason-render";

type PanelCommandId =
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

interface PanelCommand {
  id: PanelCommandId;
  label: string;
  inputLabel?: string;
}

interface PanelEdit {
  kind: "filter" | "language" | "input";
  draft: string;
}

export interface MasonPanelState {
  command: PanelCommandId;
  commandIndex: number;
  query: string;
  category: string | undefined;
  language: string | undefined;
  inputs: Record<PanelCommandId, string>;
  filter: string;
  scroll: number;
  loading: boolean;
  edit: PanelEdit | undefined;
  model: DisplayModel;
  packages: unknown[];
  lastAction?: unknown;
}

export interface MasonPanel {
  title: string;
  state: MasonPanelState;
  refresh(): Promise<MasonPanelState>;
  search(query?: string, filters?: { category: string | undefined; language: string | undefined }): Promise<MasonPanelState>;
  install(packages: string[]): Promise<MasonPanelState>;
  uninstall(packages: string[]): Promise<MasonPanelState>;
  update(packages?: string[]): Promise<MasonPanelState>;
  doctor(): Promise<MasonPanelState>;
  runCurrent(): Promise<MasonPanelState>;
  handleInput(key: string): Promise<"close" | void>;
  render(): string;
  renderLines(width: number): string[];
}

const PANEL_COMMANDS: readonly PanelCommand[] = [
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

export function createMasonPanel(bridge: CliBridge): MasonPanel {
  const state: MasonPanelState = {
    command: "search",
    commandIndex: 0,
    query: "",
    category: undefined,
    language: undefined,
    inputs: {
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
    },
    filter: "",
    scroll: 0,
    loading: false,
    edit: undefined,
    model: modelForResult("packages", [], "mason search"),
    packages: [],
  };

  async function execute(planned: PanelInvocation): Promise<MasonPanelState> {
    state.loading = true;
    state.model = { kind: "summary", title: planned.title, lines: ["Loading..."] };
    try {
      const data = await bridge.run(planned.argv);
      state.lastAction = data;
      state.model = modelForResult(planned.resultKind, data, planned.title);
      state.packages = Array.isArray(data) && (planned.resultKind === "packages" || planned.resultKind === "installed") ? data : state.packages;
    } catch (err) {
      state.model = errorDisplay(planned.title, messageFromError(err));
    } finally {
      state.loading = false;
    }
    return state;
  }

  const panel: MasonPanel = {
    title: "mason4agents",
    state,
    async refresh() {
      const refreshResult = await bridge.run(["refresh"]);
      state.lastAction = refreshResult;
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async search(query = "", filters: { category: string | undefined; language: string | undefined } = { category: undefined, language: undefined }) {
      state.commandIndex = commandIndex("search");
      state.command = "search";
      state.query = query;
      state.inputs.search = query;
      state.category = filters.category;
      state.language = filters.language;
      return execute(buildSearchInvocation(state));
    },
    async install(packages: string[]) {
      state.lastAction = await bridge.run(["install", ...packages]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async uninstall(packages: string[]) {
      state.lastAction = await bridge.run(["uninstall", ...packages]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async update(packages: string[] = []) {
      state.lastAction = await bridge.run(["update", ...packages]);
      return this.search(state.query, { category: state.category, language: state.language });
    },
    async doctor() {
      state.commandIndex = commandIndex("doctor");
      state.command = "doctor";
      return execute({ argv: ["doctor"], resultKind: "doctor", title: "mason doctor" });
    },
    async runCurrent() {
      try {
        return await execute(buildInvocation(state));
      } catch (err) {
        state.model = errorDisplay("mason4agents", messageFromError(err));
        return state;
      }
    },
    async handleInput(key: string) {
      if (state.edit) {
        await handleEditKey(state, key, () => panel.runCurrent());
        return;
      }
      if (isCloseKey(key)) return "close";
      if (isNextCommandKey(key)) {
        selectCommand(state, state.commandIndex + 1);
        await panel.runCurrent();
        return;
      }
      if (isPreviousCommandKey(key)) {
        selectCommand(state, state.commandIndex - 1);
        await panel.runCurrent();
        return;
      }
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
        state.scroll += 1;
        return;
      }
      if (isScrollUpKey(key)) {
        state.scroll = Math.max(0, state.scroll - 1);
        return;
      }
      if (isPageDownKey(key)) {
        state.scroll += 10;
        return;
      }
      if (isPageUpKey(key)) {
        state.scroll = Math.max(0, state.scroll - 10);
        return;
      }
      if (isEnterKey(key)) {
        await panel.runCurrent();
        return;
      }
    },
    render() {
      return renderPanelLines(state, 120).join("\n");
    },
    renderLines(width: number) {
      return renderPanelLines(state, width);
    },
  };

  return panel;
}

export async function openMasonPanel(ctx: unknown, bridge: CliBridge): Promise<MasonPanel> {
  const panel = createMasonPanel(bridge);
  await panel.runCurrent();

  const anyCtx = ctx as { hasUI?: boolean; ui?: { custom?: (factory: Function) => unknown } };
  if (anyCtx.hasUI !== false && typeof anyCtx.ui?.custom === "function") {
    await anyCtx.ui.custom((tui: unknown, _theme: unknown, _keybindings: unknown, done: (result?: unknown) => void) => ({
      render(width: number) {
        return panel.renderLines(width);
      },
      handleInput(key: string) {
        void panel.handleInput(key).then((result) => {
          if (result === "close") {
            done(undefined);
          } else {
            requestTuiRender(tui);
          }
        });
      },
      invalidate() {},
    }));
  }
  return panel;
}

interface PanelInvocation {
  argv: string[];
  resultKind: MasonResultKind;
  title: string;
}

function buildInvocation(state: MasonPanelState): PanelInvocation {
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
      return { argv: ["install", ...packages], resultKind: "install", title: "mason install" };
    }
    case "uninstall": {
      const packages = splitInput(state.inputs.uninstall);
      if (packages.length === 0) throw new MasonCommandInputError("uninstall requires package names. Press e to enter packages.");
      return { argv: ["uninstall", ...packages], resultKind: "uninstall", title: "mason uninstall" };
    }
    case "update":
      return { argv: ["update", ...splitInput(state.inputs.update)], resultKind: "install", title: "mason update" };
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

function buildSearchInvocation(state: MasonPanelState): PanelInvocation {
  const query = state.inputs.search.trim();
  state.query = query;
  const argv = ["search"];
  if (query.length > 0) argv.push(query);
  if (state.category) argv.push("--category", state.category);
  if (state.language && state.language.trim().length > 0) argv.push("--language", state.language.trim());
  const title = state.language && state.language.trim().length > 0 ? `mason search${query ? ` ${query}` : ""} language=${state.language.trim()}` : `mason search${query ? ` ${query}` : ""}`;
  return { argv, resultKind: "packages", title };
}

function renderPanelLines(state: MasonPanelState, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines = [
    truncateToWidth("mason4agents package manager", safeWidth),
    truncateToWidth(renderCommandTabs(state), safeWidth),
    truncateToWidth(renderStateLine(state), safeWidth),
  ];
  if (state.edit) lines.push(truncateToWidth(`${state.edit.kind}> ${state.edit.draft}`, safeWidth));
  lines.push("");
  const output = renderDisplay(state.model, { width: safeWidth, filter: state.filter, scroll: state.scroll, maxRows: 18 });
  lines.push(...output);
  lines.push("");
  lines.push(truncateToWidth("Keys: ←/→ or Tab command  Enter run  e edit  / filter  l language  ↑/↓ scroll  q/Esc close", safeWidth));
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

function renderCommandTabs(state: MasonPanelState): string {
  return PANEL_COMMANDS.map((command, index) => (index === state.commandIndex ? `[${command.label}]` : ` ${command.label} `)).join(" ");
}

function renderStateLine(state: MasonPanelState): string {
  const command = currentCommand(state);
  const parts = [`command=${command.label}`];
  if (command.inputLabel) {
    const value = state.inputs[state.command];
    parts.push(`${command.inputLabel}=${value.length > 0 ? value : "-"}`);
  }
  if (state.command === "search") parts.push(`language=${state.language && state.language.length > 0 ? state.language : "-"}`);
  if (state.filter.length > 0) parts.push(`filter=${state.filter}`);
  if (state.loading) parts.push("loading");
  return parts.join("  ");
}

function handleEditKey(state: MasonPanelState, key: string, runCurrent: () => Promise<MasonPanelState>): Promise<MasonPanelState> | void {
  const edit = state.edit;
  if (!edit) return;
  if (isEnterKey(key)) {
    const draft = edit.draft.trim();
    if (edit.kind === "filter") {
      state.filter = draft;
      state.scroll = 0;
      state.edit = undefined;
      return;
    }
    if (edit.kind === "language") {
      state.language = draft.length > 0 ? draft : undefined;
      state.scroll = 0;
      state.edit = undefined;
      return runCurrent();
    }
    state.inputs[state.command] = draft;
    if (state.command === "search") state.query = draft;
    state.scroll = 0;
    state.edit = undefined;
    return runCurrent();
  }
  if (isCloseKey(key)) {
    state.edit = undefined;
    return;
  }
  if (key === "\b" || key === "\x7f" || key === "backspace") {
    edit.draft = edit.draft.slice(0, -1);
    return;
  }
  if (key.length === 1 && key >= " ") edit.draft += key;
}

function selectCommand(state: MasonPanelState, nextIndex: number): void {
  const count = PANEL_COMMANDS.length;
  state.commandIndex = ((nextIndex % count) + count) % count;
  state.command = PANEL_COMMANDS[state.commandIndex]!.id;
  state.scroll = 0;
  state.filter = "";
  state.edit = undefined;
}

function currentCommand(state: MasonPanelState): PanelCommand {
  return PANEL_COMMANDS[state.commandIndex]!;
}

function commandIndex(command: PanelCommandId): number {
  return PANEL_COMMANDS.findIndex((item) => item.id === command);
}

function splitInput(input: string): string[] {
  return tokenizeMasonArgs(input.trim());
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncateToWidth(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function isCloseKey(key: string): boolean {
  return key === "q" || key === "\x1b" || key === "escape" || key === "esc";
}

function isEnterKey(key: string): boolean {
  return key === "\r" || key === "\n" || key === "enter" || key === "return";
}

function isNextCommandKey(key: string): boolean {
  return key === "tab" || key === "right" || key === "\x1b[C";
}

function isPreviousCommandKey(key: string): boolean {
  return key === "shift+tab" || key === "left" || key === "\x1b[D";
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

function requestTuiRender(tui: unknown): void {
  if (typeof tui !== "object" || tui === null) return;
  const candidate = tui as { requestRender?: (force?: boolean) => unknown; invalidate?: () => unknown };
  if (typeof candidate.requestRender === "function") {
    candidate.requestRender(true);
  } else if (typeof candidate.invalidate === "function") {
    candidate.invalidate();
  }
}