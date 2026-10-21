import path from "node:path";
import { readDispatchStream, readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";

/**
 * A dispatch whose process still runs with its cwd inside the worktree. A checkout that is held like this is
 * somebody's live floor: moving it, or aborting the git operation it is in the middle of, would pull that floor out.
 */
export function liveDispatchIn(rootDir: string, worktree: string): boolean {
  for (const header of readDispatchStreamHeaders(rootDir)) {
    if (!header.cwd) continue;
    const relative = path.relative(worktree, header.cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const worker = readDispatchStream(rootDir, header.dispatchId)?.process;
    if (worker && !worker.exited && runtimePidIsAlive(worker.pid)) return true;
  }
  return false;
}
