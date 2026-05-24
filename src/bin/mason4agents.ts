#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { resolveMasonBinary } from "../pi/binary";

const binary = resolveMasonBinary();
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env: process.env });

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
  process.exit(code ?? 1);
});
