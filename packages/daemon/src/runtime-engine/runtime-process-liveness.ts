import { childProcessErrorCode } from "./runtime-process-signals.ts";

/** OS observation for lifecycle producers and process-tree stop proofs. Business readers use
 * readDispatchLifecycle; this probe cannot decide admission, capacity, recovery or settlement. */
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
