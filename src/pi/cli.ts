import { spawn } from "node:child_process";
import { resolveMasonBinary } from "./binary";

export interface CliBridge {
  run(args: string[], options?: CliRunOptions): Promise<unknown>;
}

export interface CliRunOptions {
  signal?: AbortSignal;
}

export class MasonCliError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly stderr: string;

  constructor(message: string, code: string, details: unknown, stderr: string) {
    super(message);
    this.name = "MasonCliError";
    this.code = code;
    this.details = details;
    this.stderr = stderr;
  }
}

export function createCliBridge(binary?: string, startUrl?: string): CliBridge {
  return {
    run(args: string[], options?: CliRunOptions): Promise<unknown> {
      return runCliJson(binary ?? resolveMasonBinary(process.env, startUrl ?? import.meta.url), args, options);
    },
  };
}

export function runCliJson(binary: string, args: string[], options: CliRunOptions = {}): Promise<unknown> {
  const finalArgs = args.includes("--json") ? args : [...args, "--json"];
  if (options.signal?.aborted) {
    return Promise.reject(new MasonCliError("mason4agents command aborted before start", "aborted", undefined, ""));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, finalArgs, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      reject(new MasonCliError("mason4agents command aborted", "aborted", undefined, stderr));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      let parsed: unknown;
      if (code === 0 || stdout.startsWith("{")) {
        try {
          parsed = parseJson(stdout, stderr);
        } catch (err) {
          reject(err);
          return;
        }
      }
      if (code === 0 && isOkEnvelope(parsed)) {
        resolve(parsed.data);
        return;
      }
      if (code === 0) {
        resolve(parsed);
        return;
      }
      if (isErrorEnvelope(parsed)) {
        reject(new MasonCliError(parsed.error.message, parsed.error.code, parsed, stderr));
        return;
      }
      reject(new MasonCliError(stderr || `mason4agents exited with code ${code ?? -1}`, "command_failed", parsed, stderr));
    });
  });
}

function parseJson(stdout: string, stderr: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new MasonCliError(`mason4agents produced invalid JSON on stdout: ${(cause as Error).message}`, "invalid_json", stdout, stderr);
  }
}

function isOkEnvelope(value: unknown): value is { ok: true; data: unknown } {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true && "data" in value;
}

function isErrorEnvelope(value: unknown): value is { ok: false; error: { code: string; message: string } } {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false || typeof envelope.error !== "object" || envelope.error === null) return false;
  const error = envelope.error as { code?: unknown; message?: unknown };
  return typeof error.code === "string" && typeof error.message === "string";
}
