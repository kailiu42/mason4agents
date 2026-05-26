import type { CliBridge, CliRunOptions } from "./cli";
import { MasonCommandInputError, tokenizeMasonArgs } from "../mason-args";
import { errorDisplay, modelForResult, usageDisplay, type DisplayModel, type MasonResultKind } from "./mason-render";
import { registerInstalledTools, renderRegisterResult } from "./register";

export { MasonCommandInputError, tokenizeMasonArgs } from "../mason-args";

export type MasonCommandName =
  | "refresh"
  | "search"
  | "list"
  | "installed"
  | "outdated"
  | "install"
  | "uninstall"
  | "update"
  | "which"
  | "bin-dir"
  | "env"
  | "doctor"
  | "register";

export interface ParsedMasonCommand {
  kind: "command";
  command: MasonCommandName;
  argv: string[];
  resultKind: MasonResultKind;
  title: string;
}

export interface ParsedMasonUsage {
  kind: "usage";
}

export interface ParsedMasonRegister {
  kind: "register";
  argv: string[];
  title: string;
}

export type ParsedMasonInput = ParsedMasonCommand | ParsedMasonRegister | ParsedMasonUsage;

const SHELLS = new Set(["bash", "zsh", "fish", "powershell", "cmd", "json"]);

export async function executeMasonCommand(input: string, bridge: CliBridge, options: CliRunOptions = {}): Promise<DisplayModel> {
  let parsed: ParsedMasonInput;
  try {
    parsed = parseMasonCommandInput(input);
  } catch (err) {
    return errorDisplay("mason4agents", messageFromError(err), usageDisplay().lines);
  }
  if (parsed.kind === "usage") return usageDisplay();
  if (parsed.kind === "register") {
    try {
      const result = registerInstalledTools(parsed.argv);
      return { kind: "summary", title: parsed.title, lines: renderRegisterResult(result).split("\n") };
    } catch (err) {
      return errorDisplay(parsed.title, messageFromError(err), usageDisplay().lines);
    }
  }
  try {
    const data = await bridge.run(parsed.argv, options);
    return modelForResult(parsed.resultKind, data, parsed.title);
  } catch (err) {
    return errorDisplay(parsed.title, messageFromError(err));
  }
}

export function parseMasonCommandInput(input: string): ParsedMasonInput {
  const tokens = tokenizeMasonArgs(input);
  if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help" || tokens[0] === "-h") return { kind: "usage" };
  return parseMasonCommandTokens(tokens);
}

export function parseMasonCommandTokens(tokens: readonly string[]): ParsedMasonInput {
  const command = tokens[0];
  if (!command) return { kind: "usage" };
  if (command === "help" || command === "--help" || command === "-h") return { kind: "usage" };
  const rest = tokens.slice(1);
  switch (command) {
    case "refresh":
      return parseRefresh(rest);
    case "search":
      return parseSearch(rest);
    case "list":
      return parseList(rest);
    case "installed":
      return parseInstalled(rest);
    case "outdated":
      return parseOutdated(rest);
    case "install":
      return parseInstall(rest);
    case "uninstall":
      return parseUninstall(rest);
    case "update":
      return parseUpdate(rest);
    case "which":
      return parseWhich(rest);
    case "bin-dir":
      return parseNoArgCommand("bin-dir", rest, ["bin-dir"], "bin-dir", "mason bin-dir");
    case "env":
      return parseEnv(rest);
    case "doctor":
      return parseNoArgCommand("doctor", rest, ["doctor"], "doctor", "mason doctor");
    case "register":
      return parseRegister(rest);
    default:
      throw new MasonCommandInputError(`Unknown /mason subcommand: ${command}`);
  }
}

function parseRefresh(tokens: readonly string[]): ParsedMasonCommand {
  let registry: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isHelp(token)) return usageAsError("refresh");
    const option = readOption(tokens, index, "--registry");
    if (option) {
      registry = option.value;
      index = option.nextIndex;
      continue;
    }
    throw new MasonCommandInputError(`refresh does not accept positional argument: ${token}`);
  }
  const argv = ["refresh"];
  pushOption(argv, "--registry", registry);
  return command("refresh", argv, "refresh", "mason refresh");
}

function parseSearch(tokens: readonly string[]): ParsedMasonCommand {
  let query: string | undefined;
  let category: string | undefined;
  let language: string | undefined;
  let registry: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isHelp(token)) return usageAsError("search");
    const categoryOption = readOption(tokens, index, "--category");
    if (categoryOption) {
      category = categoryOption.value;
      index = categoryOption.nextIndex;
      continue;
    }
    const languageOption = readOption(tokens, index, "--language");
    if (languageOption) {
      language = languageOption.value;
      index = languageOption.nextIndex;
      continue;
    }
    const registryOption = readOption(tokens, index, "--registry");
    if (registryOption) {
      registry = registryOption.value;
      index = registryOption.nextIndex;
      continue;
    }
    rejectUnknownOption(token);
    if (query !== undefined) throw new MasonCommandInputError("search accepts at most one query; quote spaces if needed.");
    query = token;
  }
  const argv = ["search"];
  if (query && query.length > 0) argv.push(query);
  pushOption(argv, "--category", category);
  pushOption(argv, "--language", language);
  pushOption(argv, "--registry", registry);
  const title = language && language.length > 0 ? `mason search${query ? ` ${query}` : ""} language=${language}` : `mason search${query ? ` ${query}` : ""}`;
  return command("search", argv, "packages", title);
}

function parseList(tokens: readonly string[]): ParsedMasonCommand {
  let installed = false;
  let outdated = false;
  let registry: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isHelp(token)) return usageAsError("list");
    if (token === "--installed") {
      installed = true;
      continue;
    }
    if (token === "--outdated") {
      outdated = true;
      continue;
    }
    const registryOption = readOption(tokens, index, "--registry");
    if (registryOption) {
      registry = registryOption.value;
      index = registryOption.nextIndex;
      continue;
    }
    rejectUnknownOption(token);
    throw new MasonCommandInputError(`list does not accept positional argument: ${token}`);
  }
  if (installed && outdated) throw new MasonCommandInputError("list cannot combine --installed and --outdated.");
  const argv = ["list"];
  if (installed) argv.push("--installed");
  if (outdated) argv.push("--outdated");
  pushOption(argv, "--registry", registry);
  if (installed) return command("list", argv, "installed", "mason list --installed");
  return command("list", argv, "packages", outdated ? "mason list --outdated" : "mason list");
}

function parseInstalled(tokens: readonly string[]): ParsedMasonCommand {
  if (tokens.length > 0) rejectUnexpectedArgs("installed", tokens);
  return command("installed", ["list", "--installed"], "installed", "mason installed");
}

function parseOutdated(tokens: readonly string[]): ParsedMasonCommand {
  let registry: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const registryOption = readOption(tokens, index, "--registry");
    if (registryOption) {
      registry = registryOption.value;
      index = registryOption.nextIndex;
      continue;
    }
    rejectUnknownOption(token);
    throw new MasonCommandInputError(`outdated does not accept positional argument: ${token}`);
  }
  const argv = ["list", "--outdated"];
  pushOption(argv, "--registry", registry);
  return command("outdated", argv, "packages", "mason outdated");
}

function parseInstall(tokens: readonly string[]): ParsedMasonCommand {
  const parsed = parsePackageCommand("install", tokens, true);
  if (parsed.packages.length === 0) throw new MasonCommandInputError("install requires at least one package.");
  const argv = ["install", ...parsed.packages];
  pushOption(argv, "--registry", parsed.registry);
  if (parsed.allowBuildScripts) argv.push("--allow-build-scripts");
  return command("install", argv, "install", "mason install");
}

function parseUninstall(tokens: readonly string[]): ParsedMasonCommand {
  const packages = parsePlainPositionals("uninstall", tokens);
  if (packages.length === 0) throw new MasonCommandInputError("uninstall requires at least one package.");
  return command("uninstall", ["uninstall", ...packages], "uninstall", "mason uninstall");
}

function parseUpdate(tokens: readonly string[]): ParsedMasonCommand {
  const parsed = parsePackageCommand("update", tokens, true);
  const argv = ["update", ...parsed.packages];
  pushOption(argv, "--registry", parsed.registry);
  if (parsed.allowBuildScripts) argv.push("--allow-build-scripts");
  return command("update", argv, "install", "mason update");
}

function parseWhich(tokens: readonly string[]): ParsedMasonCommand {
  const positionals = parsePlainPositionals("which", tokens);
  if (positionals.length !== 1) throw new MasonCommandInputError("which requires exactly one executable.");
  return command("which", ["which", positionals[0]!], "which", `mason which ${positionals[0]!}`);
}

function parseRegister(tokens: readonly string[]): ParsedMasonRegister {
  if (tokens.length === 0) throw new MasonCommandInputError("register requires at least one target: --omp");
  for (const token of tokens) {
    if (isHelp(token)) return { kind: "register", argv: ["--help"], title: "mason register" };
    if (token !== "--omp") throw new MasonCommandInputError(`register does not accept argument: ${token}`);
  }
  return { kind: "register", argv: [...tokens], title: "mason register --omp" };
}

function parseEnv(tokens: readonly string[]): ParsedMasonCommand {
  let shell: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isHelp(token)) return usageAsError("env");
    const shellOption = readOption(tokens, index, "--shell");
    if (shellOption) {
      shell = shellOption.value;
      index = shellOption.nextIndex;
      continue;
    }
    rejectUnknownOption(token);
    throw new MasonCommandInputError(`env does not accept positional argument: ${token}`);
  }
  if (!shell) throw new MasonCommandInputError("env requires --shell bash|zsh|fish|powershell|cmd|json.");
  if (!SHELLS.has(shell)) throw new MasonCommandInputError(`Unsupported shell: ${shell}`);
  return command("env", ["env", "--shell", shell], "env", `mason env --shell ${shell}`);
}

function parseNoArgCommand(commandName: MasonCommandName, tokens: readonly string[], argv: string[], resultKind: MasonResultKind, title: string): ParsedMasonCommand {
  if (tokens.length > 0) rejectUnexpectedArgs(commandName, tokens);
  return command(commandName, argv, resultKind, title);
}

function parsePackageCommand(commandName: string, tokens: readonly string[], allowRegistry: boolean): { packages: string[]; registry?: string; allowBuildScripts: boolean } {
  const packages: string[] = [];
  let registry: string | undefined;
  let allowBuildScripts = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isHelp(token)) return usageAsError(commandName);
    if (token === "--allow-build-scripts") {
      allowBuildScripts = true;
      continue;
    }
    if (allowRegistry) {
      const registryOption = readOption(tokens, index, "--registry");
      if (registryOption) {
        registry = registryOption.value;
        index = registryOption.nextIndex;
        continue;
      }
    }
    rejectUnknownOption(token);
    packages.push(token);
  }
  const result: { packages: string[]; registry?: string; allowBuildScripts: boolean } = { packages, allowBuildScripts };
  if (registry !== undefined) result.registry = registry;
  return result;
}

function parsePlainPositionals(commandName: string, tokens: readonly string[]): string[] {
  const positionals: string[] = [];
  for (const token of tokens) {
    if (isHelp(token)) return usageAsError(commandName);
    rejectUnknownOption(token);
    positionals.push(token);
  }
  return positionals;
}

function command(commandName: MasonCommandName, argv: string[], resultKind: MasonResultKind, title: string): ParsedMasonCommand {
  return { kind: "command", command: commandName, argv, resultKind, title };
}

function pushOption(argv: string[], name: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) argv.push(name, value);
}

function readOption(tokens: readonly string[], index: number, name: string): { value: string; nextIndex: number } | undefined {
  const token = tokens[index]!;
  if (token === name) {
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) throw new MasonCommandInputError(`${name} requires a value.`);
    return { value, nextIndex: index + 1 };
  }
  const prefix = `${name}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length);
    if (value.length === 0) throw new MasonCommandInputError(`${name} requires a value.`);
    return { value, nextIndex: index };
  }
  return undefined;
}

function rejectUnknownOption(token: string): void {
  if (token.startsWith("--")) throw new MasonCommandInputError(`Unknown option: ${token}`);
}

function rejectUnexpectedArgs(commandName: string, tokens: readonly string[]): never {
  throw new MasonCommandInputError(`${commandName} does not accept arguments: ${tokens.join(" ")}`);
}

function usageAsError(commandName: string): never {
  throw new MasonCommandInputError(`Use /mason help for ${commandName} usage.`);
}

function isHelp(token: string): boolean {
  return token === "--help" || token === "-h";
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
