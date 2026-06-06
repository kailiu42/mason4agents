import type { CliBridge, CliRunOptions } from "./cli";
import { createMasonTui, type MasonTui, type MasonTuiHost, type MasonTuiState, type MasonTuiStyle } from "../tui/mason-tui";
import type { MasonResultKind } from "./mason-render";

export type MasonPanelState = MasonTuiState;
export type MasonPanel = MasonTui;

export interface MasonPanelInitialCommand {
   argv: string[];
   resultKind: MasonResultKind;
   title: string;
   syncAfterPackageChange?: boolean;
   preservePackage?: string;
}

export interface MasonPanelOptions {
   syncLspConfig?: () => unknown | Promise<unknown>;
   notify?: (message: string, level?: "info" | "error") => unknown;
   requestRender?: () => unknown;
   onLongOperationStart?: (promise: Promise<unknown>) => unknown;
   progressTimeoutMs?: number;
   initialCommand?: MasonPanelInitialCommand;
}

export function createMasonPanel(bridge: CliBridge, options: MasonPanelOptions = {}): MasonPanel {
   return createMasonTui(masonPanelHost(bridge, options), options.progressTimeoutMs === undefined ? undefined : { progressTimeoutMs: options.progressTimeoutMs });
}

export async function openMasonPanel(ctx: unknown, bridge: CliBridge, options: MasonPanelOptions = {}): Promise<MasonPanel> {
   let activeTui: unknown;
   let activeComponent: { invalidate?: () => unknown } | undefined;
   const requestRender = () => {
      requestPanelRender(activeTui, activeComponent);
      options.requestRender?.();
   };
   const panel = createMasonPanel(bridge, {
      ...options,
      notify: options.notify ?? ((message, level) => notifyFromContext(ctx, message, level)),
      requestRender,
   });

   const anyCtx = ctx as { hasUI?: boolean; ui?: { custom?: (factory: Function, options?: unknown) => unknown } };
   if (anyCtx.hasUI !== false && typeof anyCtx.ui?.custom === "function") {
      const reservedLongOperation = reserveInitialLongOperation(options);
      const releaseReservedLongOperation = () => {
         reservedLongOperation?.release();
      };
      panel.state.loading = true;
      panel.state.model = { kind: "summary", title: options.initialCommand?.title ?? "mason list", lines: ["Loading..."] };
      let initialLoadStarted = false;
      let closed = false;
      const startInitialLoad = () => {
         if (initialLoadStarted) return;
         initialLoadStarted = true;
         setTimeout(() => {
            if (closed) {
               releaseReservedLongOperation();
               return;
            }
            const running = runInitialPanelCommand(panel, options.initialCommand);
            releaseReservedLongOperation();
            void running.then(requestRender, requestRender);
         }, 0);
      };
      await anyCtx.ui.custom((tui: unknown, theme: unknown, _keybindings: unknown, done: (result?: unknown) => void) => {
         activeTui = tui;
         const component = {
            width: "100%",
            render(width: number) {
               startInitialLoad();
               return panel.renderLines(width, styleFromPiTheme(theme));
            },
            handleInput(...keys: unknown[]) {
               void panel.handleInput(...keys).then((result) => {
                  if (result === "close") {
                     closed = true;
                     releaseReservedLongOperation();
                     done(undefined);
                  } else {
                     requestPanelRender(tui, component);
                  }
               });
            },
            invalidate() {
               requestTuiRender(tui);
            },
         };
         activeComponent = component;
         return component;
      }, {
         overlay: true,
         overlayOptions: {
            width: "100%",
            maxHeight: "90%",
            anchor: "top-center",
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
         },
      });
      if (!initialLoadStarted) {
         setTimeout(() => {
            if (!initialLoadStarted) releaseReservedLongOperation();
         }, 0);
      }
   } else if (options.initialCommand) {
      await runInitialPanelCommand(panel, options.initialCommand);
   } else {
      await panel.runCurrent();
   }
   return panel;
}

function reserveInitialLongOperation(options: MasonPanelOptions): { release(): void } | undefined {
   if (!isLongOperationArgs(options.initialCommand?.argv ?? [])) return undefined;
   let released = false;
   let resolveRelease!: () => void;
   const pending = new Promise<void>((resolve) => {
      resolveRelease = resolve;
   });
   options.onLongOperationStart?.(pending);
   return {
      release() {
         if (released) return;
         released = true;
         resolveRelease();
      },
   };
}

function runInitialPanelCommand(panel: MasonPanel, initial: MasonPanelInitialCommand | undefined): Promise<MasonPanelState> {
   if (!initial) return panel.runCurrent();
   const options: { syncAfterPackageChange?: boolean; preservePackage?: string } = {};
   if (initial.syncAfterPackageChange) options.syncAfterPackageChange = true;
   if (initial.preservePackage !== undefined) options.preservePackage = initial.preservePackage;
   return panel.runProgress(initial.argv, initial.resultKind, initial.title, options);
}

function masonPanelHost(bridge: CliBridge, options: MasonPanelOptions): MasonTuiHost {
   const host: MasonTuiHost = {
      runCli(args: string[], runOptions) {
         const bridgeOptions: CliRunOptions | undefined = runOptions ? {
            ...runOptions,
            onProgress(event) {
               runOptions.onProgress?.(event);
               options.requestRender?.();
            },
         } : undefined;
         const promise = bridge.run(args, bridgeOptions);
         if (isLongOperationArgs(args)) options.onLongOperationStart?.(promise);
         return promise;
      },
   };
   if (options.syncLspConfig) host.syncAfterPackageChange = options.syncLspConfig;
   if (options.notify) host.notify = options.notify;
   return host;
}

function isLongOperationArgs(args: readonly string[]): boolean {
   const command = args[0];
   return command === "install" || command === "update" || command === "uninstall" || command === "refresh";
}

function notifyFromContext(ctx: unknown, message: string, level?: "info" | "error"): void {
   const anyCtx = ctx as { ui?: { notify?: (message: string, level?: string) => unknown } };
   if (typeof anyCtx.ui?.notify === "function") anyCtx.ui.notify(message, level);
}

function requestPanelRender(tui: unknown, component: { invalidate?: () => unknown } | undefined): void {
   requestTuiRender(tui);
   try {
      component?.invalidate?.();
   } catch {
      // Re-render best effort only; command state has already been updated.
   }
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

function styleFromPiTheme(theme: unknown): MasonTuiStyle | undefined {
   const record = typeof theme === "object" && theme !== null ? theme as {
      fg?: (token: string, text: string) => string;
      bg?: (token: string, text: string) => string;
      bold?: (text: string) => string;
   } : undefined;
   if (typeof record?.fg !== "function" && typeof record?.bg !== "function" && typeof record?.bold !== "function") return undefined;
   const fg = (token: string, text: string) => typeof record?.fg === "function" ? record.fg(token, text) : text;
   const bg = (token: string, text: string) => typeof record?.bg === "function" ? record.bg(token, text) : text;
   const bold = (text: string) => typeof record?.bold === "function" ? record.bold(text) : text;
   const selected = (text: string) => bg("selectedBg", fg("accent", text));
   const toolHeader = (text: string) => bg("customMessageBg", fg("toolTitle", bold(text)));
   const popupBody = (text: string) => bg("customMessageBg", text);
   return {
      title: (text) => fg("toolTitle", bold(text)),
      tabBar: (text) => bg("customMessageBg", text),
      tab: (text) => bg("customMessageBg", fg("muted", text)),
      activeTab: (text) => bg("selectedBg", fg("accent", bold(text))),
      tabSeparator: (text) => bg("customMessageBg", fg("borderMuted", text)),
      tabMeta: (text) => bg("customMessageBg", fg("muted", text)),
      divider: (text) => fg("borderAccent", text),
      edit: (text) => fg("accent", text),
      notice: (text) => fg("accent", text),
      tableTitle: (text) => fg("toolTitle", bold(text)),
      tableHeader: toolHeader,
      tableSeparator: (text) => fg("borderMuted", text),
      selectedRow: selected,
      installedMarker: (text) => fg("success", bold(text)),
      help: (text) => fg("dim", text),
      shortcutKey: (text) => fg("accent", bold(text)),
      shortcutAction: (text) => fg("customMessageText", text),
      popupBorder: (text) => fg("borderAccent", text),
      popupTitle: (text) => bg("selectedBg", fg("accent", bold(text))),
      popupBody,
      detailLabel: (text) => fg("muted", text),
      detailValue: (text) => fg("customMessageText", text),
      detailName: (text) => fg("accent", bold(text)),
      detailStatus: (text) => fg("accent", text),
      detailActionKey: (text) => fg("accent", bold(text)),
      detailAction: (text) => fg("customMessageText", text),
   };
}
