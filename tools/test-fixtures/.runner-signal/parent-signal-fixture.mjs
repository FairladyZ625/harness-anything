import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

export function registerParentSignalFixture(label) {
  test(`production parent signal owns worker tree ${label}`, async () => {
    const pidRoot = process.env.HARNESS_FILE_WORKER_PID_ROOT;
    if (process.env.HARNESS_FILE_WORKER_FIXTURE !== "parent-signal" || pidRoot === undefined) return;
    const descendant = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000)"
    ], { stdio: "ignore" });
    mkdirSync(pidRoot, { recursive: true });
    writeFileSync(path.join(pidRoot, `${label}.json`), `${JSON.stringify({
      label,
      workerPid: process.pid,
      descendantPid: descendant.pid
    })}\n`);
    await new Promise(() => {});
  });
}
