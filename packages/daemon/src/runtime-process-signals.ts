import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-010 */
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { consumeKnownError } from "@harness-anything/kernel";

/** Reads an OS error code without trusting the error's class; callers only branch on `code`. */
export function childProcessErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "spawn_failed";
}

// Windows taskkill note retained from the spawn path: cmd.exe, and the surviving grandchild
// holds the inherited stdio pipes open, which keeps the daemon -- or a test process -- alive
// with a runtime it believes it stopped. taskkill /T ends the tree. Windows has no graceful
// signal to lose here: SIGTERM already terminates unconditionally.
export function terminateRuntimeProcess(child: Pick<ChildProcess, "killed" | "pid" | "kill">): void {
  if (child.killed || child.pid === undefined) return;
  if (process.platform === "win32") {
    /* @gate-identity check-sync-subprocess/sync-subprocess-011 */
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

export function terminateRuntimePid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1) return;
  if (process.platform === "win32") {
    terminateRuntimeProcess({ killed: false, pid, kill: () => false });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (childProcessErrorCode(error) !== "ESRCH") throw error;
    consumeKnownError(error);
  }
}
