import { childProcessErrorCode } from "./runtime-spawn-process.ts";

/** Whether one runtime worker process is still around, asked of the operating system rather than of
 * any record the daemon keeps. Adoption, cancel, the dispatch read face and the shutdown drain all
 * settle liveness here, so none of them can outlive the process it is speaking for. */
export function runtimePidIsAlive(pid: number): boolean {
  // POSIX kill(0, sig) addresses the caller's own process group and kill(negative, sig) a group by
  // id, so either would answer "alive" for a runtime that has no process at all. A runtime pid is a
  // single process or it is nothing.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return childProcessErrorCode(error) === "EPERM";
  }
}
