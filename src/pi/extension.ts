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
  registerCommand(ctx, "mason", "Open mason4agents package manager", async (_args) => openMasonPanel(apiCtx, bridge));
  registerCommand(apiCtx, "mason-doctor", "Run mason4agents doctor", async () => {
    try {
      const result = await bridge.run(["doctor"]);
      (apiCtx as { sendMessage?: (msg: unknown) => unknown })?.sendMessage?.({ role: "user", content: JSON.stringify(result, null, 2) });
    } catch {
      // silently swallow so the command never crashes
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
  handler: (args: string, commandCtx?: unknown) => unknown | Promise<unknown>
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