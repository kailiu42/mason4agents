import type { CliBridge } from "./cli";
import { createMasonTui, type MasonTui, type MasonTuiHost, type MasonTuiState, type MasonTuiStyle } from "../tui/mason-tui";

export type MasonPanelState = MasonTuiState;
export type MasonPanel = MasonTui;

export interface MasonPanelOptions {
  syncLspConfig?: () => unknown;
  notify?: (message: string, level?: "info" | "error") => unknown;
}

export function createMasonPanel(bridge: CliBridge, options: MasonPanelOptions = {}): MasonPanel {
  return createMasonTui(masonPanelHost(bridge, options));
}

export async function openMasonPanel(ctx: unknown, bridge: CliBridge, options: MasonPanelOptions = {}): Promise<MasonPanel> {
  const panel = createMasonPanel(bridge, {
    ...options,
    notify: options.notify ?? ((message, level) => notifyFromContext(ctx, message, level)),
  });

  const anyCtx = ctx as { hasUI?: boolean; ui?: { custom?: (factory: Function, options?: unknown) => unknown } };
  if (anyCtx.hasUI !== false && typeof anyCtx.ui?.custom === "function") {
    panel.state.loading = true;
    panel.state.model = { kind: "summary", title: "mason list", lines: ["Loading..."] };
    let activeTui: unknown;
    let activeComponent: { invalidate?: () => unknown } | undefined;
    let initialLoadStarted = false;
    let closed = false;
    const startInitialLoad = () => {
      if (initialLoadStarted) return;
      initialLoadStarted = true;
      setTimeout(() => {
        if (closed) return;
        void panel.runCurrent().then(
          () => requestPanelRender(activeTui, activeComponent),
          () => requestPanelRender(activeTui, activeComponent),
        );
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
        handleInput(key: string) {
          void panel.handleInput(key).then((result) => {
            if (result === "close") {
              closed = true;
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
  } else {
    await panel.runCurrent();
  }
  return panel;
}

function masonPanelHost(bridge: CliBridge, options: MasonPanelOptions): MasonTuiHost {
  const host: MasonTuiHost = {
    runCli(args: string[]) {
      return bridge.run(args);
    },
  };
  if (options.syncLspConfig) host.syncAfterPackageChange = options.syncLspConfig;
  if (options.notify) host.notify = options.notify;
  return host;
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
  const selected = (text: string) => bg("selectedBg", fg("text", text));
  const toolHeader = (text: string) => bg("customMessageBg", fg("toolTitle", bold(text)));
  const popupBody = (text: string) => bg("customMessageBg", fg("customMessageText", text));
  return {
    title: (text) => fg("toolTitle", bold(text)),
    tabBar: (text) => bg("customMessageBg", text),
    tab: (text) => bg("customMessageBg", fg("muted", text)),
    activeTab: (text) => bg("selectedBg", fg("accent", bold(text))),
    stateLine: (text) => fg("muted", text),
    divider: (text) => fg("borderAccent", text),
    edit: (text) => fg("accent", text),
    notice: (text) => fg("accent", text),
    tableTitle: (text) => fg("toolTitle", bold(text)),
    tableHeader: toolHeader,
    tableSeparator: (text) => fg("borderMuted", text),
    selectedRow: selected,
    help: (text) => fg("dim", text),
    popupBorder: (text) => fg("borderAccent", text),
    popupTitle: (text) => bg("selectedBg", fg("accent", bold(text))),
    popupBody,
  };
}
