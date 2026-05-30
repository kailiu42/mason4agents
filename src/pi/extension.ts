import { createCliBridge } from "./cli";
import type { CliBridge } from "./cli";
import { executeMasonCommand, parseMasonCommandInput } from "./mason-command";
import { openMasonPanel, type MasonPanelInitialCommand } from "./mason-panel";
import { modelSupportsFiltering, renderDisplay, renderDisplayText, type DisplayModel } from "./mason-render";
import { registerPiTools } from "./pi-tools";
import { ensureMasonBinOnPath } from "./path-env";
import { syncMasonLspConfig } from "./lsp-config";
import { syncOmpLspDefaultsCache } from "./omp-lsp-defaults";
import { pathToFileURL } from "node:url";

export interface PiActivationResult {
  name: "mason4agents";
  binDir: string;
  tools: unknown[];
}

export async function activate(ctx: unknown, bridge?: CliBridge): Promise<PiActivationResult> {
  const pathInfo = ensureMasonBinOnPath();
  syncOmpLspDefaultsCache();
  syncMasonLspConfig();
  const apiCtx = ctx;
  const cliBridge = bridge ?? createCliBridge(undefined, extensionStartUrl(ctx));
  const syncAfterPackageChange = () => {
    syncOmpLspDefaultsCache();
    syncMasonLspConfig();
  };
  let activeLongOperation: Promise<void> | undefined;
  const trackLongOperation = (promise: Promise<unknown>) => {
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    activeLongOperation = tracked;
    void tracked.finally(() => {
      if (activeLongOperation === tracked) activeLongOperation = undefined;
    });
  };
  registerCommand(ctx, "mason", {
    description: "Open mason4agents package manager",
    getArgumentCompletions: masonCommandArgumentCompletions,
    async handler(args, commandCtx) {
      const restoreWorking = suppressLocalCommandWorking(commandCtx);
      try {
        emptyMasonArgumentCompletionSuppressedAt = 0;
        const input = typeof args === "string" ? args.trim() : "";
        const shownInUi = canShowCustomUi(commandCtx);
        if (input.length === 0) {
          const panel = await openMasonPanel(commandCtx, cliBridge, { syncLspConfig: syncAfterPackageChange, onLongOperationStart: trackLongOperation });
          if (!shownInUi) {
            publishMessage(apiCtx, "mason4agents", panel.render());
          }
          return;
        }

        const initialCommand = directLongMasonCommand(input);
        if (shownInUi && initialCommand) {
          if (activeLongOperation) {
            reportLongOperationBlocked(commandCtx, apiCtx);
            return;
          }
          await openMasonPanel(commandCtx, cliBridge, {
            syncLspConfig: syncAfterPackageChange,
            initialCommand,
            onLongOperationStart: trackLongOperation,
          });
          return;
        }

        const model = await executeMasonCommand(input, cliBridge);
        if (model.kind !== "error" && shouldSyncLspConfigAfterMasonCommand(input)) {
          syncAfterPackageChange();
        }
        publishMessage(apiCtx, "mason4agents", renderDisplayText(model));
      } catch (err) {
        reportCommandError(commandCtx, apiCtx, "mason", err);
      } finally {
        restoreWorking();
      }
    },
  });

  const tools = registerPiTools(ctx, cliBridge, { syncLspConfig: syncMasonLspConfig });
  registerSessionStart(ctx, () => {
    ensureMasonBinOnPath();
    syncOmpLspDefaultsCache();
    syncMasonLspConfig();
  });
  return { name: "mason4agents", binDir: pathInfo.binDir, tools };
}

export default activate;

interface CommandAutocompleteItem {
  label: string;
  value: string;
  description?: string;
  hint?: string;
}

interface CommandRegistrationOptions {
  description: string;
  getArgumentCompletions?: (argumentPrefix: string) => CommandAutocompleteItem[] | null;
  handler: (args: string, commandCtx: unknown) => unknown | Promise<unknown>;
}

interface MasonCommandSuggestion {
  name: string;
  description: string;
  usage?: string;
}

const MASON_COMMAND_SUGGESTIONS: readonly MasonCommandSuggestion[] = [
  { name: "refresh", description: "Refresh the Mason Registry cache", usage: "[--registry <source>]" },
  { name: "search", description: "Search registry packages", usage: "[query] [--category <category>] [--language <language>] [--registry <source>]" },
  { name: "list", description: "List registry packages", usage: "[--installed] [--outdated] [--registry <source>]" },
  { name: "installed", description: "List installed packages" },
  { name: "outdated", description: "List outdated packages", usage: "[--registry <source>]" },
  { name: "install", description: "Install one or more packages", usage: "<pkg[@version]>... [--registry <source>] [--allow-build-scripts]" },
  { name: "uninstall", description: "Uninstall one or more packages", usage: "<pkg>..." },
  { name: "update", description: "Update packages", usage: "[pkg...] [--registry <source>] [--allow-build-scripts]" },
  { name: "which", description: "Resolve an installed executable path", usage: "<executable>" },
  { name: "bin-dir", description: "Print the Mason bin directory" },
  { name: "env", description: "Print PATH setup for a shell", usage: "--shell bash|zsh|fish|powershell|cmd|json" },
  { name: "doctor", description: "Run diagnostics" },
  { name: "register", description: "Register installed Mason LSP tools with OMP", usage: "--omp" },
];
let emptyMasonArgumentCompletionSuppressedAt = 0;

function registerCommand(
  ctx: unknown,
  name: string,
  options: CommandRegistrationOptions
): void {
  const anyCtx = ctx as {
    commands?: {
      register?: (name: string, options: unknown) => unknown;
      registerCommand?: (name: string, options: unknown) => unknown;
    };
    command?: { register?: (name: string, options: unknown) => unknown };
    registerCommand?: (name: string, options: unknown) => unknown;
  };
  if (typeof anyCtx.registerCommand === "function") {
    anyCtx.registerCommand(name, options);
  } else if (typeof anyCtx.commands?.registerCommand === "function") {
    anyCtx.commands.registerCommand(name, options);
  } else if (typeof anyCtx.commands?.register === "function") {
    anyCtx.commands.register(name, options);
  } else if (typeof anyCtx.command?.register === "function") {
    anyCtx.command.register(name, options);
  }
}

function masonCommandArgumentCompletions(argumentPrefix: string): CommandAutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart();
  if (prefix.length === 0) return emptyMasonArgumentCompletions();
  const spaceIndex = prefix.indexOf(" ");
  if (spaceIndex < 0) return commandSuggestionItems(prefix.toLowerCase());

  const command = prefix.slice(0, spaceIndex).toLowerCase();
  const suggestion = MASON_COMMAND_SUGGESTIONS.find((item) => item.name === command);
  if (!suggestion) return commandSuggestionItems(command);
  if (!suggestion.usage) return null;

  return [{
    label: suggestion.name,
    value: prefix,
    description: suggestion.description,
    hint: suggestion.usage,
  }];
}

function emptyMasonArgumentCompletions(): CommandAutocompleteItem[] | null {
  const now = Date.now();
  if (emptyMasonArgumentCompletionSuppressedAt !== 0 && now - emptyMasonArgumentCompletionSuppressedAt < 10_000) {
    emptyMasonArgumentCompletionSuppressedAt = 0;
    return commandSuggestionItems("");
  }
  emptyMasonArgumentCompletionSuppressedAt = now;
  return null;
}

function commandSuggestionItems(prefix: string): CommandAutocompleteItem[] | null {
  const items: CommandAutocompleteItem[] = [];
  for (const suggestion of MASON_COMMAND_SUGGESTIONS) {
    if (prefix.length > 0 && !suggestion.name.startsWith(prefix)) continue;
    if (suggestion.usage) {
      items.push({
        label: suggestion.name,
        value: `${suggestion.name} `,
        description: suggestion.description,
        hint: suggestion.usage,
      });
      continue;
    }
    items.push({
      label: suggestion.name,
      value: `${suggestion.name} `,
      description: suggestion.description,
    });
  }
  return items.length > 0 ? items : null;
}

function canShowCustomUi(ctx: unknown): boolean {
  const anyCtx = ctx as { hasUI?: boolean; ui?: { custom?: unknown } };
  return anyCtx.hasUI !== false && typeof anyCtx.ui?.custom === "function";
}

function suppressLocalCommandWorking(ctx: unknown): () => void {
  const ui = (ctx as { ui?: { setWorkingVisible?: (visible: boolean) => unknown } }).ui;
  if (typeof ui?.setWorkingVisible !== "function") return () => {};
  try {
    ui.setWorkingVisible(false);
  } catch {
    return () => {};
  }
  return () => {
    try {
      ui.setWorkingVisible?.(true);
    } catch {
      // Ignore UI restore failures; command output/error handling has already completed.
    }
  };
}

async function showDisplayPanel(ctx: unknown, model: DisplayModel): Promise<void> {
  const anyCtx = ctx as { ui?: { custom?: (factory: Function) => unknown } };
  await anyCtx.ui?.custom?.((tui: unknown, _theme: unknown, _keybindings: unknown, done: (result?: unknown) => void) => {
    const state = { filter: "", filterDraft: "", editingFilter: false, scroll: 0 };
    return {
      render(width: number) {
        return renderDisplayPanel(model, state, width);
      },
      handleInput(key: string) {
        if (state.editingFilter) {
          handleFilterInput(state, key);
          requestTuiRender(tui);
          return;
        }
        if (isCloseKey(key)) {
          done(undefined);
          return;
        }
        if (key === "/" && modelSupportsFiltering(model)) {
          state.filterDraft = state.filter;
          state.editingFilter = true;
          requestTuiRender(tui);
          return;
        }
        if (isScrollDownKey(key)) state.scroll += 1;
        if (isScrollUpKey(key)) state.scroll = Math.max(0, state.scroll - 1);
        if (isPageDownKey(key)) state.scroll += 10;
        if (isPageUpKey(key)) state.scroll = Math.max(0, state.scroll - 10);
        requestTuiRender(tui);
      },
      invalidate() {},
    };
  });
}

function publishMessage(ctx: unknown, customType: string, content: string): boolean {
  const anyCtx = ctx as {
    sendMessage?: (message: unknown, options?: unknown) => unknown;
  };
  if (typeof anyCtx.sendMessage === "function") {
    anyCtx.sendMessage({ customType, content, display: true }, { deliverAs: "nextTurn" });
    return true;
  }
  return false;
}

export function extensionStartUrl(ctx: unknown): string {
  const extension = (ctx as { extension?: { resolvedPath?: unknown; path?: unknown } }).extension;
  const path = typeof extension?.resolvedPath === "string" ? extension.resolvedPath : typeof extension?.path === "string" ? extension.path : "";
  if (path.length === 0) return import.meta.url;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return pathToFileURL(`/${path.replaceAll("\\", "/")}`).href;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)) return path;
  return pathToFileURL(path).href;
}

function reportCommandError(commandCtx: unknown, apiCtx: unknown, command: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const anyCommandCtx = commandCtx as { ui?: { notify?: (message: string, level?: string) => unknown } };
  if (typeof anyCommandCtx.ui?.notify === "function") {
    anyCommandCtx.ui.notify(`${command}: ${msg}`, "error");
  } else {
    publishMessage(apiCtx, `mason4agents-${command}-error`, `${command}: ${msg}`);
  }
}

function directLongMasonCommand(input: string): MasonPanelInitialCommand | undefined {
  let parsed: ReturnType<typeof parseMasonCommandInput>;
  try {
    parsed = parseMasonCommandInput(input);
  } catch {
    return undefined;
  }
  if (parsed.kind !== "command") return undefined;
  if (parsed.command !== "install" && parsed.command !== "update" && parsed.command !== "uninstall" && parsed.command !== "refresh") return undefined;
  const initial: MasonPanelInitialCommand = {
    argv: parsed.argv,
    resultKind: parsed.resultKind,
    title: parsed.title,
  };
  if (parsed.command === "install" || parsed.command === "update" || parsed.command === "uninstall") {
    initial.syncAfterPackageChange = true;
    const packageName = firstPackageArgument(parsed.argv);
    if (packageName !== undefined) initial.preservePackage = packageName;
  }
  return initial;
}

function firstPackageArgument(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--registry") {
      index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    return token;
  }
  return undefined;
}

function reportLongOperationBlocked(commandCtx: unknown, apiCtx: unknown): void {
  const message = "A mason4agents operation is already running; wait for it to finish before starting another.";
  const anyCommandCtx = commandCtx as { ui?: { notify?: (message: string, level?: string) => unknown } };
  if (typeof anyCommandCtx.ui?.notify === "function") {
    anyCommandCtx.ui.notify(message, "error");
  } else {
    publishMessage(apiCtx, "mason4agents", message);
  }
}
function shouldSyncLspConfigAfterMasonCommand(input: string): boolean {
  try {
    const parsed = parseMasonCommandInput(input);
    return parsed.kind === "command" && (parsed.command === "install" || parsed.command === "update" || parsed.command === "uninstall");
  } catch {
    return false;
  }
}

function renderDisplayPanel(model: DisplayModel, state: { filter: string; filterDraft: string; editingFilter: boolean; scroll: number }, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines = renderDisplay(model, { width: safeWidth, filter: state.filter, scroll: state.scroll, fixedHeight: true });
  if (state.editingFilter) {
    lines.splice(1, 0, truncateToWidth(`filter> ${state.filterDraft}`, safeWidth));
  }
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

function handleFilterInput(state: { filter: string; filterDraft: string; editingFilter: boolean; scroll: number }, key: string): void {
  if (key === "\r" || key === "\n" || key === "enter" || key === "return") {
    state.filter = state.filterDraft.trim();
    state.scroll = 0;
    state.editingFilter = false;
    return;
  }
  if (key === "\x1b" || key === "escape" || key === "esc") {
    state.editingFilter = false;
    return;
  }
  if (key === "\b" || key === "\x7f" || key === "backspace") {
    state.filterDraft = state.filterDraft.slice(0, -1);
    return;
  }
  if (key.length === 1 && key >= " ") state.filterDraft += key;
}

function truncateToWidth(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function isCloseKey(key: string): boolean {
  return key === "q" || key === "\x03" || key === "ctrl+c" || key === "ctrl-c" || key === "\x1b" || key === "escape" || key === "esc";
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

function registerSessionStart(ctx: unknown, handler: () => unknown): void {
  const anyCtx = ctx as {
    events?: { on?: (event: string, handler: () => unknown) => unknown };
    on?: (event: string, handler: () => unknown) => unknown;
  };
  if (typeof anyCtx.events?.on === "function") {
    anyCtx.events.on("session_start", handler);
  } else if (typeof anyCtx.on === "function") {
    anyCtx.on("session_start", handler);
  }
}
