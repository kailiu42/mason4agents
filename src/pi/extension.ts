import { createCliBridge } from "./cli";
import type { CliBridge } from "./cli";
import type * as MasonCommandModule from "./mason-command";
import type { ParsedMasonInput } from "./mason-command";
import type * as MasonLspConfigModule from "./lsp-config";
import type * as MasonPanelModule from "./mason-panel";
import type { MasonPanelInitialCommand } from "./mason-panel";
import type * as MasonRenderModule from "./mason-render";
import type * as OmpLspDefaultsModule from "./omp-lsp-defaults";
import { registerPiTools } from "./pi-tools";
import { ensureMasonBinOnPath } from "./path-env";
import { pathToFileURL } from "node:url";

export interface PiActivationResult {
  name: "mason4agents";
  binDir: string;
  tools: unknown[];
}

export async function activate(ctx: unknown, bridge?: CliBridge): Promise<PiActivationResult> {
  const pathInfo = ensureMasonBinOnPath();
  scheduleBackgroundLspStartupSync(process.env);
  const apiCtx = ctx;
  const cliBridge = bridge ?? createCliBridge(undefined, extensionStartUrl(ctx));
  const syncAfterPackageChange = () => syncOmpAndMasonLspConfig(process.env);
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
          const { openMasonPanel } = await loadMasonPanelModule();
          const panel = await openMasonPanel(commandCtx, cliBridge, { syncLspConfig: syncAfterPackageChange, onLongOperationStart: trackLongOperation });
          if (!shownInUi) {
            publishMessage(apiCtx, "mason4agents", panel.render());
          }
          return;
        }

        if (shownInUi) {
          const initialCommand = await directLongMasonCommand(input);
          if (initialCommand) {
          if (activeLongOperation) {
            reportLongOperationBlocked(commandCtx, apiCtx);
            return;
          }
            const { openMasonPanel } = await loadMasonPanelModule();
          await openMasonPanel(commandCtx, cliBridge, {
            syncLspConfig: syncAfterPackageChange,
            initialCommand,
            onLongOperationStart: trackLongOperation,
          });
          return;
        }
        }

        const [{ executeMasonCommand }, { renderDisplayText }] = await Promise.all([
          loadMasonCommandModule(),
          loadMasonRenderModule(),
        ]);
        const model = await executeMasonCommand(input, cliBridge);
        if (model.kind !== "error" && await shouldSyncLspConfigAfterMasonCommand(input)) {
          await syncAfterPackageChange();
        }
        publishMessage(apiCtx, "mason4agents", renderDisplayText(model));
      } catch (err) {
        reportCommandError(commandCtx, apiCtx, "mason", err);
      } finally {
        restoreWorking();
      }
    },
  });

  const tools = registerPiTools(ctx, cliBridge, { syncLspConfig: () => syncMasonLspConfigLazy(process.env) });
  registerSessionStart(ctx, () => {
    ensureMasonBinOnPath();
    scheduleBackgroundLspStartupSync(process.env);
  });
  return { name: "mason4agents", binDir: pathInfo.binDir, tools };
}

let masonCommandModule: Promise<typeof MasonCommandModule> | undefined;
let masonPanelModule: Promise<typeof MasonPanelModule> | undefined;
let masonRenderModule: Promise<typeof MasonRenderModule> | undefined;
let masonLspConfigModule: Promise<typeof MasonLspConfigModule> | undefined;
let ompLspDefaultsModule: Promise<typeof OmpLspDefaultsModule> | undefined;

function loadMasonCommandModule(): Promise<typeof MasonCommandModule> {
  return masonCommandModule ??= import("./mason-command");
}

function loadMasonPanelModule(): Promise<typeof MasonPanelModule> {
  return masonPanelModule ??= import("./mason-panel");
}

function loadMasonRenderModule(): Promise<typeof MasonRenderModule> {
  return masonRenderModule ??= import("./mason-render");
}

function loadMasonLspConfigModule(): Promise<typeof MasonLspConfigModule> {
  return masonLspConfigModule ??= import("./lsp-config");
}

function loadOmpLspDefaultsModule(): Promise<typeof OmpLspDefaultsModule> {
  return ompLspDefaultsModule ??= import("./omp-lsp-defaults");
}

const BACKGROUND_LSP_STARTUP_SYNC_DELAY_MS = 1_000;

let backgroundLspStartupSync: Promise<void> | undefined;
let backgroundLspStartupSyncTimer: ReturnType<typeof setTimeout> | undefined;
let runPendingBackgroundLspStartupSync: (() => void) | undefined;

function scheduleBackgroundLspStartupSync(env: NodeJS.ProcessEnv): void {
  if (backgroundLspStartupSync !== undefined) return;
  const envSnapshot = { ...env };
  const { promise, resolve } = Promise.withResolvers<void>();
  const run = () => {
    backgroundLspStartupSyncTimer = undefined;
    runPendingBackgroundLspStartupSync = undefined;
    void runLspStartupSync(envSnapshot).finally(() => {
      backgroundLspStartupSync = undefined;
      resolve();
    });
  };
  runPendingBackgroundLspStartupSync = run;
  backgroundLspStartupSyncTimer = setTimeout(run, BACKGROUND_LSP_STARTUP_SYNC_DELAY_MS);
  backgroundLspStartupSync = promise;
}

async function runLspStartupSync(env: NodeJS.ProcessEnv): Promise<void> {
  const [defaults, lsp] = await Promise.allSettled([
    loadOmpLspDefaultsModule(),
    loadMasonLspConfigModule(),
  ]);
  if (defaults.status === "fulfilled") {
    runLspStartupSyncStep("syncOmpLspDefaultsCache", () => defaults.value.syncOmpLspDefaultsCache(env));
  } else {
    reportBackgroundLspStartupSyncFailure("loadOmpLspDefaultsModule", defaults.reason);
  }
  if (lsp.status === "fulfilled") {
    runLspStartupSyncStep("syncMasonLspConfig", () => lsp.value.syncMasonLspConfig(env));
  } else {
    reportBackgroundLspStartupSyncFailure("loadMasonLspConfigModule", lsp.reason);
  }
}

async function syncOmpAndMasonLspConfig(env: NodeJS.ProcessEnv): Promise<void> {
  const [defaults, lsp] = await Promise.all([
    loadOmpLspDefaultsModule(),
    loadMasonLspConfigModule(),
  ]);
  defaults.syncOmpLspDefaultsCache(env);
  lsp.syncMasonLspConfig(env);
}

async function syncMasonLspConfigLazy(env: NodeJS.ProcessEnv): Promise<void> {
  const { syncMasonLspConfig } = await loadMasonLspConfigModule();
  syncMasonLspConfig(env);
}

function runLspStartupSyncStep(name: string, step: () => unknown): void {
  try {
    step();
  } catch (err) {
    reportBackgroundLspStartupSyncFailure(name, err);
  }
}

function reportBackgroundLspStartupSyncFailure(name: string, err: unknown): void {
  console.error(`[mason4agents] background ${name} failed`, err);
}

export async function flushBackgroundLspStartupSyncForTests(): Promise<void> {
  const pending = backgroundLspStartupSync;
  if (pending === undefined) return;
  if (backgroundLspStartupSyncTimer !== undefined) {
    clearTimeout(backgroundLspStartupSyncTimer);
    backgroundLspStartupSyncTimer = undefined;
  }
  runPendingBackgroundLspStartupSync?.();
  await pending;
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

async function directLongMasonCommand(input: string): Promise<MasonPanelInitialCommand | undefined> {
  let parsed: ParsedMasonInput;
  try {
    parsed = (await loadMasonCommandModule()).parseMasonCommandInput(input);
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

async function shouldSyncLspConfigAfterMasonCommand(input: string): Promise<boolean> {
  try {
    const parsed = (await loadMasonCommandModule()).parseMasonCommandInput(input);
    return parsed.kind === "command" && (parsed.command === "install" || parsed.command === "update" || parsed.command === "uninstall");
  } catch {
    return false;
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
