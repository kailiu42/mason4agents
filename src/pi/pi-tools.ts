import { Type } from "@sinclair/typebox";
import type { CliBridge } from "./cli";

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult>;
}

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

type ToolExecutor = (input: unknown, options?: { signal?: AbortSignal }) => Promise<PiToolResult>;

export function createPiTools(bridge: CliBridge): PiToolDefinition[] {
  return [
    tool("mason_list", "mason list", "List Mason packages", listSchema(), async (input, options) => {
      const args = validateObject(input);
      const argv = ["list"];
      if (args.installed === true) argv.push("--installed");
      if (args.outdated === true) argv.push("--outdated");
      return result(await bridge.run(argv, options));
    }),
    tool("mason_search", "mason search", "Search Mason Registry packages", searchSchema(), async (input, options) => {
      const args = validateObject(input);
      const argv = ["search"];
      if (typeof args.query === "string" && args.query.length > 0) argv.push(args.query);
      if (typeof args.category === "string" && args.category.length > 0) argv.push("--category", args.category);
      if (typeof args.language === "string" && args.language.length > 0) argv.push("--language", args.language);
      return result(await bridge.run(argv, options));
    }),
    tool("mason_install", "mason install", "Install Mason packages", installSchema(), async (input, options) => {
      const args = validateObject(input);
      const packages = validateStringArray(args.packages, "packages");
      const argv = ["install", ...packages];
      if (typeof args.registry === "string" && args.registry.length > 0) argv.push("--registry", args.registry);
      if (args.allow_build_scripts === true) argv.push("--allow-build-scripts");
      return result(await bridge.run(argv, options));
    }),
    tool("mason_uninstall", "mason uninstall", "Uninstall Mason packages", uninstallSchema(), async (input, options) => {
      const args = validateObject(input);
      const packages = validateStringArray(args.packages, "packages");
      return result(await bridge.run(["uninstall", ...packages], options));
    }),
    tool("mason_update", "mason update", "Update Mason packages", updateSchema(), async (input, options) => {
      const args = validateObject(input);
      const packages = args.packages === undefined || (Array.isArray(args.packages) && args.packages.length === 0)
        ? []
        : validateStringArray(args.packages, "packages");
      const argv = ["update", ...packages];
      if (typeof args.registry === "string" && args.registry.length > 0) argv.push("--registry", args.registry);
      if (args.allow_build_scripts === true) argv.push("--allow-build-scripts");
      return result(await bridge.run(argv, options));
    }),
    tool("mason_which", "mason which", "Resolve an installed executable", whichSchema(), async (input, options) => {
      const args = validateObject(input);
      if (typeof args.executable !== "string" || args.executable.length === 0) throw new Error("executable must be a non-empty string");
      return result(await bridge.run(["which", args.executable], options));
    }),
    tool("mason_env", "mason env", "Print PATH setup for shells", envSchema(), async (input, options) => {
      const args = validateObject(input);
      const shell = typeof args.shell === "string" && args.shell.length > 0 ? args.shell : "json";
      return result(await bridge.run(["env", "--shell", shell], options));
    })
  ];
}

export function registerPiTools(ctx: unknown, bridge: CliBridge): PiToolDefinition[] {
  const tools = createPiTools(bridge);
  for (const definition of tools) {
    registerTool(ctx, definition);
  }
  return tools;
}

function tool(name: string, label: string, description: string, parameters: Record<string, unknown>, executor: ToolExecutor): PiToolDefinition {
  return {
    name,
    label,
    description,
    promptSnippet: description,
    parameters,
    execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      return signal ? executor(params, { signal }) : executor(params);
    }
  };
}

function registerTool(ctx: unknown, definition: PiToolDefinition): void {
  const anyCtx = ctx as {
    tools?: { register?: (definition: PiToolDefinition) => unknown; registerTool?: (definition: PiToolDefinition) => unknown };
    registerTool?: (definition: PiToolDefinition) => unknown;
  };
  if (typeof anyCtx.registerTool === "function") {
    anyCtx.registerTool(definition);
  } else if (typeof anyCtx.tools?.registerTool === "function") {
    anyCtx.tools.registerTool(definition);
  } else if (typeof anyCtx.tools?.register === "function") {
    anyCtx.tools.register(definition);
  }
}

function result(details: unknown): PiToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function validateObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("tool input must be an object");
  return input as Record<string, unknown>;
}

function validateStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value as string[];
}

function listSchema(): Record<string, unknown> { return Type.Object({ installed: Type.Optional(Type.Boolean()), outdated: Type.Optional(Type.Boolean()) }, { additionalProperties: false }); }
function searchSchema(): Record<string, unknown> { return Type.Object({ query: Type.Optional(Type.String()), category: Type.Optional(Type.String()), language: Type.Optional(Type.String()) }, { additionalProperties: false }); }
function installSchema(): Record<string, unknown> { return Type.Object({ packages: Type.Array(Type.String(), { minItems: 1 }), registry: Type.Optional(Type.String()), allow_build_scripts: Type.Optional(Type.Boolean()) }, { additionalProperties: false, required: ["packages"] }); }
function uninstallSchema(): Record<string, unknown> { return Type.Object({ packages: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false, required: ["packages"] }); }
function updateSchema(): Record<string, unknown> { return Type.Object({ packages: Type.Optional(Type.Array(Type.String())), registry: Type.Optional(Type.String()), allow_build_scripts: Type.Optional(Type.Boolean()) }, { additionalProperties: false }); }
function whichSchema(): Record<string, unknown> { return Type.Object({ executable: Type.String() }, { additionalProperties: false, required: ["executable"] }); }
function envSchema(): Record<string, unknown> { return Type.Object({ shell: Type.Optional(Type.Union([Type.Literal("bash"), Type.Literal("zsh"), Type.Literal("fish"), Type.Literal("powershell"), Type.Literal("cmd"), Type.Literal("json")])) }, { additionalProperties: false }); }