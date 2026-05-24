import { createCliBridge } from "./cli";
import type { CliBridge } from "./cli";
import { openMasonPanel } from "./mason-panel";
import { registerPiTools } from "./pi-tools";
import { ensureMasonBinOnPath } from "./path-env";

export interface PiActivationResult {
  name: "mason4agents";
  binDir: string;
  tools: unknown[];
}

export async function activate(ctx: unknown, bridge: CliBridge = createCliBridge()): Promise<PiActivationResult> {
  const pathInfo = ensureMasonBinOnPath();
  const apiCtx = ctx;

  registerCommand(ctx, "mason", "Open mason4agents package manager", async (_args, commandCtx) => {
    try {
      const shownInUi = canShowCustomUi(commandCtx);
      const panel = await openMasonPanel(commandCtx, bridge);
      if (!shownInUi) {
        publishMessage(apiCtx, "mason4agents", panel.render());
      }
    } catch (err) {
      reportCommandError(commandCtx, apiCtx, "mason", err);
    }
  });

  registerCommand(ctx, "mason-doctor", "Run mason4agents doctor", async (_args, commandCtx) => {
    try {
      const result = await bridge.run(["doctor"]);
      const text = JSON.stringify(result, null, 2);
      if (canShowCustomUi(commandCtx)) {
        await showTextPanel(commandCtx, "mason4agents doctor", text);
      } else {
        publishMessage(apiCtx, "mason4agents-doctor", text);
      }
    } catch (err) {
      reportCommandError(commandCtx, apiCtx, "mason-doctor", err);
    }
  });

  const tools = registerPiTools(ctx, bridge);
  registerSessionStart(ctx, () => ensureMasonBinOnPath());
  return { name: "mason4agents", binDir: pathInfo.binDir, tools };
}

export default activate;

function registerCommand(
  ctx: unknown,
  name: string,
  description: string,
  handler: (args: string, commandCtx: unknown) => unknown | Promise<unknown>
): void {
  const anyCtx = ctx as {
    commands?: {
      register?: (name: string, options: unknown) => unknown;
      registerCommand?: (name: string, options: unknown) => unknown;
    };
    command?: { register?: (name: string, options: unknown) => unknown };
    registerCommand?: (name: string, options: unknown) => unknown;
  };
  const options = { description, handler };
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

function canShowCustomUi(ctx: unknown): boolean {
  const anyCtx = ctx as { hasUI?: boolean; ui?: { custom?: unknown } };
  return anyCtx.hasUI !== false && typeof anyCtx.ui?.custom === "function";
}

async function showTextPanel(ctx: unknown, title: string, text: string): Promise<void> {
  const anyCtx = ctx as { ui?: { custom?: (factory: Function) => unknown } };
  await anyCtx.ui?.custom?.((_tui: unknown, _theme: unknown, _keybindings: unknown, done: (result?: unknown) => void) => ({
    render(width: number) {
      return renderTextLines(title, text, width);
    },
    handleInput(key: string) {
      if (isCloseKey(key)) {
        done(undefined);
      }
    },
    invalidate() {},
  }));
}

function publishMessage(ctx: unknown, customType: string, content: string): void {
  const anyCtx = ctx as {
    sendMessage?: (message: unknown, options?: unknown) => unknown;
  };
  if (typeof anyCtx.sendMessage === "function") {
    anyCtx.sendMessage({ customType, content, display: true }, { deliverAs: "nextTurn" });
  }
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

function renderTextLines(title: string, text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines = [truncateToWidth(title, safeWidth), truncateToWidth("Press q or Esc to close", safeWidth), ""];
  for (const line of text.split("\n")) {
    lines.push(truncateToWidth(line, safeWidth));
  }
  return lines;
}

function truncateToWidth(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function isCloseKey(key: string): boolean {
  return key === "q" || key === "\x1b" || key === "escape" || key === "esc" || key === "enter" || key === "return" || key === "\r" || key === "\n";
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