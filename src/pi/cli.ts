import { spawn } from "node:child_process";
import { resolveMasonBinary } from "./binary";

export interface CliBridge {
  run(args: string[], options?: CliRunOptions): Promise<unknown>;
}

export interface CliRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: CliProgressEvent) => void;
}

export interface CliProgressEvent {
  kind: "progress";
  schema_version: 1;
  operation: string;
  phase: string;
  status: "started" | "running" | "succeeded" | "failed" | "skipped";
  package?: string;
  message: string;
  elapsed_ms: number;
  total_bytes?: number;
  downloaded_bytes?: number;
  download_percent?: number;
  bytes_per_second?: number;
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
    let stderrLineBuffer = "";
    let settled = false;
    const rejectFromProgress = (err: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      reject(err);
    };
    const handleProgressLine = (line: string) => {
      if (!options.onProgress || settled) return;
      const event = parseProgressEvent(line);
      if (!event) return;
      try {
        options.onProgress(event);
      } catch (err) {
        rejectFromProgress(err);
      }
    };
    const handleStderrChunk = (chunk: string) => {
      stderr += chunk;
      if (!options.onProgress || settled) return;
      stderrLineBuffer += chunk;
      for (;;) {
        const newline = stderrLineBuffer.indexOf("\n");
        if (newline === -1) break;
        const line = stderrLineBuffer.slice(0, newline).replace(/\r$/, "");
        stderrLineBuffer = stderrLineBuffer.slice(newline + 1);
        handleProgressLine(line);
      }
    };
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
    child.stderr.on("data", handleStderrChunk);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stderrLineBuffer.length > 0) {
        handleProgressLine(stderrLineBuffer.replace(/\r$/, ""));
        stderrLineBuffer = "";
      }
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

function parseProgressEvent(line: string): CliProgressEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isCliProgressEvent(parsed)) return undefined;
  return parsed;
}

function isCliProgressEvent(value: unknown): value is CliProgressEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as {
    kind?: unknown;
    schema_version?: unknown;
    operation?: unknown;
    phase?: unknown;
    status?: unknown;
    package?: unknown;
    message?: unknown;
    elapsed_ms?: unknown;
    total_bytes?: unknown;
    downloaded_bytes?: unknown;
    download_percent?: unknown;
    bytes_per_second?: unknown;
  };
  return event.kind === "progress"
    && event.schema_version === 1
    && typeof event.operation === "string"
    && typeof event.phase === "string"
    && isCliProgressStatus(event.status)
    && (event.package === undefined || typeof event.package === "string")
    && typeof event.message === "string"
    && typeof event.elapsed_ms === "number"
    && isOptionalNumber(event.total_bytes)
    && isOptionalNumber(event.downloaded_bytes)
    && isOptionalNumber(event.download_percent)
    && isOptionalNumber(event.bytes_per_second);
}

function isCliProgressStatus(value: unknown): value is CliProgressEvent["status"] {
  return value === "started"
    || value === "running"
    || value === "succeeded"
    || value === "failed"
    || value === "skipped";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
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
