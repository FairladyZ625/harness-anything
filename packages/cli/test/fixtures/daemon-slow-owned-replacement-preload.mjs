import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const markerPath = process.env.HARNESS_TEST_DAEMON_SLOW_REPLACEMENT_MARKER;
const evidencePath = process.env.HARNESS_TEST_DAEMON_SLOW_REPLACEMENT_EVIDENCE;
const delayMs = Number(process.env.HARNESS_TEST_DAEMON_SLOW_REPLACEMENT_MS);
const socketIndex = process.argv.indexOf("--socket");
const socketPath = socketIndex >= 0 ? process.argv[socketIndex + 1] : undefined;
const isReplacementServe = process.argv.includes("daemon")
  && process.argv.includes("serve")
  && !process.argv.includes("--check");

if (process.platform !== "win32"
  && markerPath
  && evidencePath
  && socketPath
  && Number.isSafeInteger(delayMs)
  && delayMs > 0
  && isReplacementServe
  && existsSync(markerPath)) {
  rmSync(markerPath, { force: true });
  const ownerPath = `${socketPath}.owner`;
  const ownerPoll = setInterval(() => {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      if (owner?.schema !== "daemon-socket-owner/v1" || owner.pid !== process.pid) return;
      clearInterval(ownerPoll);
      writeFileSync(evidencePath, JSON.stringify({
        pid: process.pid,
        ownerPath,
        pausedAt: new Date().toISOString(),
        delayMs
      }), "utf8");
      const resumer = spawn(process.execPath, [
        "-e",
        `setTimeout(() => process.kill(${process.pid}, "SIGCONT"), ${delayMs})`
      ], { detached: true, stdio: "ignore" });
      resumer.unref();
      process.kill(process.pid, "SIGSTOP");
    } catch {
      // Ownership is published atomically; keep polling until this process owns it.
    }
  }, 10);
}
