import { syncMasonLspConfig, type MasonLspConfigSyncResult } from "./lsp-config";

export interface RegisterResult {
  targets: string[];
  omp?: MasonLspConfigSyncResult;
}

export function registerInstalledTools(args: readonly string[], env: NodeJS.ProcessEnv = process.env): RegisterResult {
  let registerOmp = false;
  for (const arg of args) {
    if (arg === "--omp") {
      registerOmp = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") throw new RegisterUsageError();
    throw new Error(`register does not accept argument: ${arg}`);
  }
  if (!registerOmp) throw new Error("register requires at least one target: --omp");

  const result: RegisterResult = { targets: [] };
  if (registerOmp) {
    result.targets.push("omp");
    result.omp = syncMasonLspConfig(env);
  }
  return result;
}

export function renderRegisterResult(result: RegisterResult): string {
  const lines = ["Registered installed Mason tools"];
  if (result.omp) {
    lines.push(
      `  OMP config:   ${result.omp.configPath}`,
      `  Changed:      ${result.omp.changed ? "yes" : "no"}`,
      `  LSP servers:  ${result.omp.servers.length > 0 ? result.omp.servers.join(", ") : "-"}`,
    );
    if (result.omp.lspPackages && result.omp.lspPackages.length > 0) {
      lines.push(`  LSP packages: ${result.omp.lspPackages.join(", ")}`);
    }
    if (result.omp.skipped) lines.push(`  Skipped:      ${result.omp.skipped}`);
  }
  return lines.join("\n");
}

export function registerUsageText(): string {
  return [
    "mason4agents register --omp",
    "",
    "Register already installed Mason tools with an agent.",
    "",
    "Options:",
    "  --omp   Update Oh My Pi .omp/agent/lsp.json with installed LSP tools",
  ].join("\n");
}

export class RegisterUsageError extends Error {
  constructor() {
    super(registerUsageText());
    this.name = "RegisterUsageError";
  }
}
