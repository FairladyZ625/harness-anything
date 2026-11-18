import { fork } from "node:child_process";
import process from "node:process";

const TERM_GRACE_MS = 100;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function signalReviewer(child, signal) {
  if (!child.pid) return false;
  try {
    return process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

// The existing sh adapter contract uses POSIX process groups. The deadline owns the result
// before signalling anything. Closing stdout during cleanup cannot turn it into a response.
export function runReviewerCommand(command, prompt, caseWaitMs) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const elapsed = () => performance.now() - startedAt;
    // execFile does not forward detached to spawn. Fork a session leader, then replace
    // its process image with the shell so the command keeps that group and the same pipes.
    const child = fork(new URL("./reviewer-adapter-entry.mjs", import.meta.url), [command], {
      detached: true,
      silent: true,
      execArgv: [],
    });
    const stdout = [];
    const stderr = [];
    let locked;
    let cleanup;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let inputError;

    function finish(result) {
      clearTimeout(deadline);
      clearTimeout(cleanup);
      resolve(result);
    }

    function stop(status, error) {
      if (locked) return;
      locked = { status, error, latencyMs: Math.round(elapsed()) };
      clearTimeout(deadline);
      try {
        if (!signalReviewer(child, "SIGTERM")) {
          finish(locked);
          return;
        }
      } catch (signalError) {
        reject(signalError);
        return;
      }
      cleanup = setTimeout(() => {
        try {
          signalReviewer(child, "SIGKILL");
        } catch (signalError) {
          reject(signalError);
        } finally {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(locked);
        }
      }, TERM_GRACE_MS);
    }

    const expire = () => stop("timedOut", `timed out after ${caseWaitMs}ms`);
    const deadline = setTimeout(expire, Math.max(1, Math.ceil(caseWaitMs - elapsed())));
    child.stdout.on("data", (chunk) => {
      if (locked) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) stop("errored", "reviewer stdout exceeded 1 MiB");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (locked) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) stop("errored", "reviewer stderr exceeded 1 MiB");
      else stderr.push(chunk);
    });
    child.stdin.on("error", (error) => {
      inputError = error.message;
    });
    child.once("error", (error) => {
      if (!locked) finish({ status: "errored", error: error.message, latencyMs: Math.round(elapsed()) });
    });
    child.once("close", (code, signal) => {
      if (!locked && elapsed() >= caseWaitMs) expire();
      if (locked) {
        // A wrapper may close its pipes while a descendant in the group ignores SIGTERM.
        try {
          if (!signalReviewer(child, 0)) finish(locked);
        } catch (signalError) {
          clearTimeout(cleanup);
          reject(signalError);
        }
        return;
      }
      const latencyMs = Math.round(elapsed());
      if (code !== 0 || inputError) {
        const error =
          Buffer.concat(stderr).toString("utf8").trim() || inputError || `reviewer exited with ${signal ?? code}`;
        finish({ status: "errored", error, latencyMs });
      } else {
        finish({ stdout: Buffer.concat(stdout).toString("utf8"), latencyMs });
      }
    });
    child.stdin.end(prompt);
  });
}
