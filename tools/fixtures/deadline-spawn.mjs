import { spawn } from "node:child_process";

// Runs the command in its own process group and kills the whole group at the deadline.
// A wrapper that re-invokes itself leaves a chain of live descendants, and killing only
// the direct child orphans that chain instead of reporting it.
export function spawnWithDeadline(command, args, options, deadlineMs = 2_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
      stdout = [],
      stderr = [];
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") reject(error);
      }
    }, deadlineMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
      });
    });
  });
}
