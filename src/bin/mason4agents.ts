#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { resolveMasonBinary } from "../pi/binary";
import { syncMasonLspConfig } from "../pi/lsp-config";
import { registerInstalledTools, registerUsageText, renderRegisterResult, RegisterUsageError } from "../pi/register";

const parsed = stripGlobalJson(process.argv.slice(2));

if (parsed.args[0] === "register") {
  runRegister(parsed.args.slice(1), parsed.json);
} else {
  const binary = resolveMasonBinary();
  const childArgs = process.argv.slice(2);
  const child = spawn(binary, childArgs, { stdio: "inherit", env: process.env });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => {
    // Remove forwarding handlers so re-sent signal terminates this process
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.removeAllListeners(sig);
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if ((code ?? 1) === 0 && shouldRegisterOmpAfterCommand(parsed.args)) {
      try {
        syncMasonLspConfig();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`mason4agents register --omp failed: ${message}`);
      }
    }
    process.exit(code ?? 1);
  });
}

function runRegister(args: readonly string[], json: boolean): never {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      if (json) console.log(JSON.stringify({ ok: true, data: { usage: registerUsageText() } }, null, 2));
      else console.log(registerUsageText());
      process.exit(0);
    }
    const result = registerInstalledTools(args);
    if (json) console.log(JSON.stringify({ ok: true, data: result }, null, 2));
    else console.log(renderRegisterResult(result));
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: { code: err instanceof RegisterUsageError ? "usage" : "error", message } }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(err instanceof RegisterUsageError ? 0 : 1);
  }
}

function stripGlobalJson(args: readonly string[]): { args: string[]; json: boolean } {
  const result: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    result.push(arg);
  }
  return { args: result, json };
}

function shouldRegisterOmpAfterCommand(args: readonly string[]): boolean {
  const command = args[0];
  return command === "install" || command === "update" || command === "uninstall";
}
