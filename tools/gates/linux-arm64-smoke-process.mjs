import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export const CLEANUP_TIMEOUT_MS = 5_000;
export const PROCESS_TREE_KILL_GRACE_MS = 300;
const PID_POLL_INTERVAL_MS = 50;
const DAEMON_READY_POLL_MS = 100;
const MAX_PID_FILE_BYTES = 1024;
const GONE_RECEIPT_CODES = new Set(["daemon_unavailable", "daemon_stopped_by_operator"]);

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    return error.code === "EPERM";
  }
}

function processGroupIsAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    return error.code === "EPERM";
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

export function waitChildExitOrDelay(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1, Math.floor(ms)));
    child.once("exit", finish);
    child.once("close", finish);
  });
}

async function waitForProcessTreeExit(child, pgid, timeoutMs) {
  const isGone = () =>
    (child.exitCode !== null || child.signalCode !== null) && !processGroupIsAlive(pgid) && !processIsAlive(pgid);
  if (isGone()) return true;
  const maxPolls = Math.max(1, Math.ceil(Math.max(1, timeoutMs) / PID_POLL_INTERVAL_MS));
  for (let attempt = 0; attempt < maxPolls && !isGone(); attempt += 1) {
    await delay(PID_POLL_INTERVAL_MS);
  }
  return isGone();
}

export function destroyChildStreams(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

async function terminateProcessTree(
  child,
  { graceMs = PROCESS_TREE_KILL_GRACE_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS },
) {
  if (child.pid === undefined || process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child, cleanupTimeoutMs);
    }
    destroyChildStreams(child);
    return child.exitCode !== null || child.signalCode !== null;
  }
  const pgid = child.pid;
  const leaderExited = () => child.exitCode !== null || child.signalCode !== null;
  if (processGroupIsAlive(pgid)) {
    signalProcessGroup(pgid, "SIGTERM");
  } else if (!leaderExited() || processIsAlive(pgid)) {
    signalProcess(pgid, "SIGTERM");
  }
  const exitedGracefully = await waitForProcessTreeExit(child, pgid, Math.min(graceMs, cleanupTimeoutMs));
  if (!exitedGracefully) {
    if (processGroupIsAlive(pgid)) signalProcessGroup(pgid, "SIGKILL");
    if (processIsAlive(pgid)) signalProcess(pgid, "SIGKILL");
    destroyChildStreams(child);
    await waitForProcessTreeExit(child, pgid, cleanupTimeoutMs);
  } else {
    destroyChildStreams(child);
  }
  return leaderExited() && !processGroupIsAlive(pgid) && !processIsAlive(pgid);
}

async function attemptTerminateProcessTree(child, options) {
  try {
    const terminatedCleanly = await terminateProcessTree(child, options);
    return { ok: true, terminatedCleanly, error: null };
  } catch (error) {
    return { ok: false, terminatedCleanly: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function probeOwnedGroupAlive(child) {
  if (process.platform === "win32" || child.pid === undefined) return { ok: true, alive: false, error: null };
  try {
    return { ok: true, alive: processGroupIsAlive(child.pid) || processIsAlive(child.pid), error: null };
  } catch (error) {
    return { ok: false, alive: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function runBoundedCommandAsync(
  command,
  args,
  { cwd, env, timeoutMs, input, label, graceMs = PROCESS_TREE_KILL_GRACE_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS },
) {
  const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settling = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") stderr += `\nstdin error: ${error.message}`;
      });
      child.stdin.end(input);
    }
    const timer = setTimeout(async () => {
      if (settling) return;
      settling = true;
      timedOut = true;
      const termination = await attemptTerminateProcessTree(child, { graceMs, cleanupTimeoutMs });
      const suffix = !termination.ok
        ? ` (cleanup error: ${termination.error})`
        : termination.terminatedCleanly
          ? ""
          : ` (process tree did not exit within ${cleanupTimeoutMs}ms)`;
      finish({
        ok: false,
        status: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        timedOut: true,
        terminatedCleanly: termination.terminatedCleanly,
        survivingProcessGroup: false,
        errorMessage: `${label} timed out after ${effectiveTimeoutMs}ms${suffix}`,
      });
    }, effectiveTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", async (error) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      let terminatedCleanly = true;
      let survivingProcessGroup = false;
      let cleanupSuffix = "";
      const groupProbe = probeOwnedGroupAlive(child);
      if (!groupProbe.ok) {
        terminatedCleanly = false;
        cleanupSuffix = ` (process group check failed: ${groupProbe.error})`;
      } else if (groupProbe.alive) {
        survivingProcessGroup = true;
        const termination = await attemptTerminateProcessTree(child, { graceMs, cleanupTimeoutMs });
        terminatedCleanly = termination.ok && termination.terminatedCleanly;
        cleanupSuffix = !termination.ok
          ? ` (cleanup error: ${termination.error})`
          : terminatedCleanly
            ? ` (reaped surviving process group -${child.pid})`
            : ` (process group did not exit within ${cleanupTimeoutMs}ms)`;
      }
      finish({
        ok: false,
        status: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        timedOut: false,
        terminatedCleanly,
        survivingProcessGroup,
        errorMessage: `${label} failed to spawn: ${error.message}${cleanupSuffix}`,
      });
    });
    child.on("close", async (status, signal) => {
      if (timedOut || settling) return;
      settling = true;
      clearTimeout(timer);
      const groupProbe = probeOwnedGroupAlive(child);
      if (!groupProbe.ok) {
        finish({
          ok: false,
          status,
          signal,
          stdout,
          stderr,
          timedOut: false,
          terminatedCleanly: false,
          survivingProcessGroup: false,
          errorMessage: `${label} process group verification failed after exit ${status}: ${groupProbe.error}`,
        });
        return;
      }
      if (!groupProbe.alive) {
        finish({
          ok: status === 0,
          status,
          signal,
          stdout,
          stderr,
          timedOut: false,
          terminatedCleanly: true,
          survivingProcessGroup: false,
          errorMessage: status === 0 ? null : `${label} exited ${status}: ${(stderr || stdout).trim()}`,
        });
        return;
      }
      const termination = await attemptTerminateProcessTree(child, { graceMs, cleanupTimeoutMs });
      const terminatedCleanly = termination.ok && termination.terminatedCleanly;
      const reapDetail = !termination.ok
        ? ` (cleanup error: ${termination.error})`
        : terminatedCleanly
          ? " (reaped surviving process group)"
          : ` (process group did not exit within ${cleanupTimeoutMs}ms)`;
      const baseError = status === 0 ? null : `${label} exited ${status}: ${(stderr || stdout).trim()}`;
      const groupError = `${label} left surviving process group -${child.pid} after exit ${status}${reapDetail}`;
      finish({
        ok: false,
        status,
        signal,
        stdout,
        stderr,
        timedOut: false,
        terminatedCleanly,
        survivingProcessGroup: true,
        errorMessage: baseError ? `${baseError}; ${groupError}` : groupError,
      });
    });
  });
}

export function hasProcessLayerFailure(result) {
  return (
    !result ||
    result.timedOut === true ||
    result.survivingProcessGroup === true ||
    result.terminatedCleanly === false ||
    (result.status === 0 && result.ok === false) ||
    result.status === null ||
    result.status === undefined
  );
}

export function isCliCommandSuccess(result) {
  return !hasProcessLayerFailure(result) && result.ok === true && result.status === 0;
}

export function formatCliFailureDetail(result) {
  if (!result) return "no command result";
  const parts = [`exit ${result.status}`];
  if (result.timedOut === true) parts.push("timedOut=true");
  if (result.survivingProcessGroup === true) parts.push("survivingProcessGroup=true");
  if (result.terminatedCleanly === false) parts.push("terminatedCleanly=false");
  if (result.errorMessage) parts.push(`error=${result.errorMessage}`);
  if (result.parseError) parts.push(`parseError=${result.parseError}`);
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stderr) parts.push(`stderr=${stderr}`);
  if (result.receipt !== undefined && result.receipt !== null) {
    parts.push(`receipt=${JSON.stringify(result.receipt)}`);
  }
  return parts.join(" ");
}

export function localDaemonSocketEndpoint(userRoot, daemonId = "default", platform = process.platform) {
  const hash = createHash("sha256")
    .update(`${path.resolve(userRoot)}\0${daemonId}`)
    .digest("hex")
    .slice(0, 16);
  const key = `u-${hash}`;
  if (platform === "win32") return `\\\\.\\pipe\\harness-anything-${key}`;
  const uid = process.getuid?.() ?? 0;
  return path.join("/tmp", `harness-anything-${uid}`, `daemon-${uid}-${key}.sock`);
}

function nonRegularFileKind(stat) {
  if (stat.isFIFO()) return "FIFO";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isSymbolicLink()) return "symlink";
  return "non-regular";
}

export function readPidFileStrict(filePath) {
  const openFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  let fd = null;
  try {
    fd = openSync(filePath, openFlags);
    const stat = fstatSync(fd);
    if (stat.isDirectory()) {
      return {
        state: "error",
        pid: null,
        error: `EISDIR: illegal operation on a directory, read '${filePath}'`,
        code: "EISDIR",
      };
    }
    if (!stat.isFile()) {
      const kind = nonRegularFileKind(stat);
      return {
        state: "error",
        pid: null,
        error: `ENOTREG: expected regular file for pid bookkeeping, got ${kind} at '${filePath}'`,
        code: "ENOTREG",
      };
    }
    if (stat.size > MAX_PID_FILE_BYTES) {
      return {
        state: "error",
        pid: null,
        error: `EFBIG: pid bookkeeping file exceeds ${MAX_PID_FILE_BYTES} bytes (${stat.size}) at '${filePath}'`,
        code: "EFBIG",
      };
    }
    const buffer = Buffer.allocUnsafe(MAX_PID_FILE_BYTES + 1);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const chunk = readSync(fd, buffer, totalRead, buffer.length - totalRead, totalRead);
      if (chunk === 0) break;
      totalRead += chunk;
    }
    if (totalRead > MAX_PID_FILE_BYTES) {
      return {
        state: "error",
        pid: null,
        error: `EFBIG: pid bookkeeping file read exceeded ${MAX_PID_FILE_BYTES} bytes at '${filePath}'`,
        code: "EFBIG",
      };
    }
    const pid = Number(buffer.subarray(0, totalRead).toString("utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return { state: "invalid", pid: null, error: null, code: null };
    return { state: "present", pid, error: null, code: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", pid: null, error: null, code: "ENOENT" };
    return {
      state: "error",
      pid: null,
      error: error instanceof Error ? error.message : String(error),
      code: typeof error?.code === "string" ? error.code : null,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readDaemonPid(userRoot) {
  return readPidFileStrict(path.join(userRoot, "daemon-default.pid"));
}

export function readDaemonSingletonLock(userRoot) {
  return readPidFileStrict(path.join(userRoot, "daemon-default.singleton.lock"));
}

export function ownedProcessTreeAlive(ownedDaemon) {
  if (!ownedDaemon) return false;
  const { child, pgid } = ownedDaemon;
  if (child.exitCode === null && child.signalCode === null) return true;
  if (pgid !== null && process.platform !== "win32") {
    return processGroupIsAlive(pgid) || processIsAlive(pgid);
  }
  return pgid !== null && processIsAlive(pgid);
}

export function spawnOwnedDaemon({ label, daemonBin, repo, userRoot, env }) {
  const daemonEnv = { ...env };
  delete daemonEnv.HARNESS_DAEMON_USER_ROOT;
  delete daemonEnv.HARNESS_DAEMON_ID;
  const child = spawn(
    daemonBin.file,
    [...daemonBin.argsPrefix, "--service", "--user-root", userRoot, "--daemon-id", "default"],
    {
      cwd: repo,
      env: daemonEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const handle = {
    label,
    userRoot,
    endpoint: localDaemonSocketEndpoint(userRoot, "default"),
    child,
    pgid: child.pid ?? null,
    ready: false,
    reportedPid: null,
    spawnError: null,
    stdout: "",
    stderr: "",
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    handle.stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    handle.stderr += chunk;
  });
  child.on("error", (error) => {
    handle.spawnError = error instanceof Error ? error.message : String(error);
  });
  return handle;
}

export async function waitForOwnedDaemonReady({
  label,
  ownedDaemon,
  checkStatus,
  budget,
  pollIntervalMs = DAEMON_READY_POLL_MS,
}) {
  const effectivePollMs = Math.max(1, Math.floor(pollIntervalMs));
  const maxAttempts = Math.max(1, Math.ceil(budget.deadlineMs / effectivePollMs) + 1);
  let lastDetail = "daemon has not reported ready yet";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (ownedDaemon.spawnError) {
      return {
        ok: false,
        timedOut: false,
        statusResult: null,
        errorMessage: `${label} daemon failed to spawn: ${ownedDaemon.spawnError}`,
      };
    }
    if (ownedDaemon.child.exitCode !== null || ownedDaemon.child.signalCode !== null) {
      return {
        ok: false,
        timedOut: false,
        statusResult: null,
        errorMessage: `${label} daemon exited before readiness (code=${ownedDaemon.child.exitCode} signal=${ownedDaemon.child.signalCode}): ${(ownedDaemon.stderr || ownedDaemon.stdout).trim()}`,
      };
    }
    const statusTimeoutMs = budget.remainingMs(`${label} daemon readiness status`);
    const statusResult = await checkStatus(statusTimeoutMs);
    if (hasProcessLayerFailure(statusResult)) {
      const detail = formatCliFailureDetail(statusResult);
      return {
        ok: false,
        timedOut: statusResult.timedOut === true,
        statusResult,
        errorMessage: statusResult.timedOut
          ? `${label} daemon readiness timed out: ${detail}`
          : `${label} daemon readiness status failed at process layer: ${detail}`,
      };
    }
    if (isCliCommandSuccess(statusResult) && statusResult.receipt?.ok === true) {
      const observedPid = typeof statusResult.receipt.pid === "number" ? statusResult.receipt.pid : null;
      if (ownedDaemon.pgid === null || observedPid !== ownedDaemon.pgid) {
        return {
          ok: false,
          timedOut: false,
          statusResult,
          errorMessage: `${label} daemon readiness identity mismatch: expected pid ${ownedDaemon.pgid ?? "none"}, observed ${observedPid ?? "none"}`,
        };
      }
      ownedDaemon.ready = true;
      ownedDaemon.reportedPid = observedPid;
      if (
        typeof statusResult.receipt.target?.endpoint === "string" &&
        statusResult.receipt.target.endpoint.length > 0
      ) {
        ownedDaemon.endpoint = statusResult.receipt.target.endpoint;
      }
      return { ok: true, timedOut: false, statusResult, errorMessage: null };
    }
    lastDetail = formatCliFailureDetail(statusResult);
    if (budget.isExpired()) {
      return {
        ok: false,
        timedOut: true,
        statusResult,
        errorMessage: `${label} daemon readiness timed out: ${lastDetail}`,
      };
    }
    const remaining = budget.remainingMs(`${label} daemon readiness wait`);
    await waitChildExitOrDelay(ownedDaemon.child, Math.min(effectivePollMs, remaining));
  }
  return {
    ok: false,
    timedOut: true,
    statusResult: null,
    errorMessage: `${label} daemon did not become ready: ${lastDetail}`,
  };
}

export function isConfirmedDaemonGone(statusResult) {
  return (
    !hasProcessLayerFailure(statusResult) &&
    statusResult.status !== 0 &&
    typeof statusResult.receipt?.code === "string" &&
    GONE_RECEIPT_CODES.has(statusResult.receipt.code)
  );
}

const UNREACHABLE_SOCKET_CODES = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EACCES", "ENOTDIR"]);

function parseJsonRpcLine(line) {
  try {
    return { ok: true, value: JSON.parse(line), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runOwnedDaemonStopRpcExchange({ label, expectedPid, sendRpc }) {
  try {
    const helloResp = await sendRpc("protocol.hello", { protocolVersion: { major: 1, minor: 1 } });
    if (helloResp?.error || helloResp?.result?.ok !== true) {
      const helloCode = typeof helloResp?.result?.code === "string" ? helloResp.result.code : "daemon_hello_rejected";
      return {
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: helloCode },
        errorMessage: `${label} daemon RPC hello rejected: ${helloResp?.error?.message ?? JSON.stringify(helloResp?.result ?? helloResp)}`,
      };
    }

    const statusResp = await sendRpc("daemon.status", {});
    if (statusResp?.error || statusResp?.result?.ok !== true) {
      const statusCode = typeof statusResp?.result?.code === "string" ? statusResp.result.code : "daemon_status_failed";
      return {
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: statusCode },
        errorMessage: `${label} daemon RPC status failed before stop: ${statusResp?.error?.message ?? JSON.stringify(statusResp?.result ?? statusResp)}`,
      };
    }

    const observedPid = typeof statusResp.result.pid === "number" ? statusResp.result.pid : null;
    if (observedPid !== expectedPid) {
      return {
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: "daemon_identity_mismatch", expectedPid, observedPid },
        errorMessage: `${label} daemon RPC identity mismatch before stop: expected pid ${expectedPid}, observed ${observedPid ?? "none"}`,
      };
    }

    const stopResp = await sendRpc("daemon.stop", {});
    if (stopResp?.error || stopResp?.result?.ok !== true) {
      const stopCode = typeof stopResp?.result?.code === "string" ? stopResp.result.code : "daemon_stop_refused";
      return {
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: stopCode },
        errorMessage: `${label} daemon RPC stop refused: ${stopResp?.error?.message ?? JSON.stringify(stopResp?.result ?? stopResp)}`,
      };
    }

    const stoppedPid = typeof stopResp.result.pid === "number" ? stopResp.result.pid : expectedPid;
    if (stoppedPid !== expectedPid) {
      return {
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: "daemon_identity_mismatch", expectedPid, observedPid: stoppedPid },
        errorMessage: `${label} daemon RPC stop pid mismatch: expected pid ${expectedPid}, observed ${stoppedPid}`,
      };
    }

    return {
      ok: true,
      status: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: true, command: "daemon-stop", pid: stoppedPid },
      errorMessage: null,
    };
  } catch (error) {
    const errorCode = typeof error?.code === "string" ? error.code : null;
    const unreachable = errorCode !== null && UNREACHABLE_SOCKET_CODES.has(errorCode);
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: unreachable ? "daemon_unavailable" : "daemon_rpc_error" },
      errorMessage: `${label} daemon RPC stop failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// RPC-only cooperative stop bound strictly to the owned daemon's verified PID.
// Unlike `ha daemon stop`, this never falls back to signalling an unverified PID file.
export async function requestOwnedDaemonCooperativeStop({
  label,
  userRoot,
  daemonId = "default",
  ownedDaemon,
  endpoint,
  timeoutMs = CLEANUP_TIMEOUT_MS,
}) {
  const expectedPid = ownedDaemon?.pgid;
  if (!ownedDaemon || !Number.isInteger(expectedPid) || expectedPid <= 0) {
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: "daemon_unowned" },
      errorMessage: `${label} cooperative stop refused: no owned daemon pid`,
    };
  }
  if (ownedDaemon.reportedPid !== null && ownedDaemon.reportedPid !== expectedPid) {
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: "daemon_identity_mismatch", expectedPid, observedPid: ownedDaemon.reportedPid },
      errorMessage: `${label} cooperative stop refused: owned pid ${expectedPid} disagrees with reported pid ${ownedDaemon.reportedPid}`,
    };
  }

  const pidInfo = readDaemonPid(userRoot);
  if (pidInfo.state === "error") {
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: "daemon_bookkeeping_unreadable" },
      errorMessage: `${label} cooperative stop aborted: failed reading daemon pid file: ${pidInfo.error}`,
    };
  }
  if (pidInfo.state === "present" && pidInfo.pid !== expectedPid) {
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: "daemon_identity_mismatch", expectedPid, observedPid: pidInfo.pid },
      errorMessage: `${label} cooperative stop refused: pidfile names ${pidInfo.pid} instead of owned pid ${expectedPid}`,
    };
  }

  const lockInfo = readDaemonSingletonLock(userRoot);
  if (lockInfo.state === "error") {
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: "daemon_bookkeeping_unreadable" },
      errorMessage: `${label} cooperative stop aborted: failed reading daemon singleton lock: ${lockInfo.error}`,
    };
  }
  if (lockInfo.state === "present" && lockInfo.pid !== expectedPid) {
    return {
      ok: false,
      status: 1,
      timedOut: false,
      stdout: "",
      stderr: "",
      receipt: { ok: false, code: "daemon_identity_mismatch", expectedPid, observedPid: lockInfo.pid },
      errorMessage: `${label} cooperative stop refused: singleton lock names ${lockInfo.pid} instead of owned pid ${expectedPid}`,
    };
  }

  const socketPath = endpoint ?? ownedDaemon.endpoint ?? localDaemonSocketEndpoint(userRoot, daemonId);
  const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let settled = false;
    let connected = false;
    let buffer = "";
    let nextId = 1;
    let pending = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending) {
        const current = pending;
        pending = null;
        current.reject(new Error(value.errorMessage ?? "daemon RPC session ended"));
      }
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        status: 1,
        timedOut: true,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: "daemon_response_timeout" },
        errorMessage: `${label} daemon RPC cooperative stop timed out after ${effectiveTimeoutMs}ms`,
      });
    }, effectiveTimeoutMs);

    const sendRpc = (method, params) =>
      new Promise((res, rej) => {
        if (settled) {
          rej(new Error("daemon RPC socket already closed"));
          return;
        }
        const id = nextId;
        nextId += 1;
        pending = { id, resolve: res, reject: rej };
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (writeError) => {
          if (writeError && pending?.id === id) {
            const current = pending;
            pending = null;
            current.reject(writeError);
          }
        });
      });

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        const parsedLine = parseJsonRpcLine(line);
        if (!parsedLine.ok) {
          finish({
            ok: false,
            status: 1,
            timedOut: false,
            stdout: "",
            stderr: "",
            receipt: { ok: false, code: "daemon_protocol_error" },
            errorMessage: `${label} daemon RPC returned malformed JSON: ${parsedLine.error}`,
          });
          return;
        }
        if (pending && parsedLine.value?.id === pending.id) {
          const current = pending;
          pending = null;
          current.resolve(parsedLine.value);
        }
      }
    });

    socket.once("error", (error) => {
      const errorCode = typeof error?.code === "string" ? error.code : null;
      const unreachable = !connected || (errorCode !== null && UNREACHABLE_SOCKET_CODES.has(errorCode));
      finish({
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: unreachable ? "daemon_unavailable" : "daemon_rpc_error" },
        errorMessage: `${label} daemon RPC ${unreachable ? "unreachable" : "error"}: ${error instanceof Error ? error.message : String(error)}`,
      });
    });

    socket.once("close", () => {
      if (settled) return;
      finish({
        ok: false,
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "",
        receipt: { ok: false, code: connected ? "daemon_closed" : "daemon_unavailable" },
        errorMessage: `${label} daemon RPC socket closed before cooperative stop completed`,
      });
    });

    socket.once("connect", async () => {
      connected = true;
      finish(await runOwnedDaemonStopRpcExchange({ label, expectedPid, sendRpc }));
    });
  });
}

export async function verifyDaemonStoppedAndCleanup({
  label,
  userRoot,
  ownedDaemon = null,
  stopDaemon,
  alreadyStopped = false,
  graceMs = PROCESS_TREE_KILL_GRACE_MS,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
}) {
  const cleanupErrors = [];
  const hasVerifiedOwnedPid = Boolean(ownedDaemon && Number.isInteger(ownedDaemon.pgid) && ownedDaemon.pgid > 0);
  const ownedAliveBefore = ownedProcessTreeAlive(ownedDaemon);

  if (hasVerifiedOwnedPid && !alreadyStopped && ownedAliveBefore) {
    const cooperativeStop =
      stopDaemon ?? ((timeoutMs) => requestOwnedDaemonCooperativeStop({ label, userRoot, ownedDaemon, timeoutMs }));
    const stopAttempt = await runAsyncCleanupStep(`${label} cleanup daemon stop`, async () => {
      const stopResult = await cooperativeStop(cleanupTimeoutMs);
      const stopConfirmedOk =
        !hasProcessLayerFailure(stopResult) &&
        stopResult.ok !== false &&
        stopResult.status === 0 &&
        stopResult.receipt?.ok === true;
      const stopConfirmedAlreadyGone = isConfirmedDaemonGone(stopResult);
      if (!stopConfirmedOk && !stopConfirmedAlreadyGone) {
        return {
          ok: false,
          errors: [
            `${label} cleanup daemon stop failed: status=${stopResult.status} timedOut=${Boolean(stopResult.timedOut)} survivingProcessGroup=${Boolean(stopResult.survivingProcessGroup)} code=${stopResult.receipt?.code ?? "none"} detail=${(stopResult.errorMessage || stopResult.stderr || stopResult.stdout || "").trim()}`,
          ],
        };
      }
      return { ok: true, errors: [] };
    });
    cleanupErrors.push(...stopAttempt.errors);
  }

  // Always reap any surviving owned process tree regardless of cooperative-stop or bookkeeping-read outcomes.
  if (ownedDaemon) {
    if (ownedProcessTreeAlive(ownedDaemon)) {
      const termination = await attemptTerminateProcessTree(ownedDaemon.child, { graceMs, cleanupTimeoutMs });
      if (!termination.ok) {
        cleanupErrors.push(`${label} cleanup owned process tree termination failed: ${termination.error}`);
      } else if (!termination.terminatedCleanly) {
        cleanupErrors.push(`${label} cleanup owned process tree did not exit within ${cleanupTimeoutMs}ms`);
      }
    } else {
      destroyChildStreams(ownedDaemon.child);
    }
  }

  const pidInfoAfter = readDaemonPid(userRoot);
  if (pidInfoAfter.state === "error") {
    cleanupErrors.push(`${label} cleanup failed reading daemon pid file: ${pidInfoAfter.error}`);
  } else if (pidInfoAfter.state === "invalid") {
    cleanupErrors.push(`${label} cleanup observed invalid daemon pid file`);
  } else if (pidInfoAfter.state === "present" && processIsAlive(pidInfoAfter.pid)) {
    cleanupErrors.push(
      `${label} cleanup observed surviving daemon pid ${pidInfoAfter.pid} (owned pgid=${ownedDaemon?.pgid ?? "none"})`,
    );
  }

  const lockInfoAfter = readDaemonSingletonLock(userRoot);
  if (lockInfoAfter.state === "error") {
    cleanupErrors.push(`${label} cleanup failed reading daemon singleton lock: ${lockInfoAfter.error}`);
  } else if (lockInfoAfter.state === "invalid") {
    cleanupErrors.push(`${label} cleanup observed invalid daemon singleton lock`);
  } else if (lockInfoAfter.state === "present" && processIsAlive(lockInfoAfter.pid)) {
    cleanupErrors.push(
      `${label} cleanup observed surviving daemon singleton lock pid ${lockInfoAfter.pid} (owned pgid=${ownedDaemon?.pgid ?? "none"})`,
    );
  }

  return { ok: cleanupErrors.length === 0, errors: cleanupErrors };
}

export async function runAsyncCleanupStep(label, fn) {
  try {
    const result = await fn();
    if (result && result.ok === false) {
      const details = Array.isArray(result.errors)
        ? result.errors
        : [result.errorMessage ?? `${label} reported failure`];
      return { ok: false, errors: details };
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`${label} failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function extractErrorMessages(error) {
  if (error instanceof AggregateError) {
    const nested = error.errors.flatMap((entry) => extractErrorMessages(entry));
    return nested.length > 0 ? nested : [error.message || String(error)];
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function captureBodyOutcome(bodyFn) {
  try {
    return { ok: true, value: await bodyFn(), error: null };
  } catch (error) {
    return { ok: false, value: undefined, error };
  }
}

export async function runWithResourceCleanups(bodyFn, cleanups) {
  const bodyOutcome = await captureBodyOutcome(bodyFn);
  const cleanupErrors = [];
  for (const { label, run } of cleanups) {
    const outcome = await runAsyncCleanupStep(label, run);
    cleanupErrors.push(...outcome.errors);
  }
  if (!bodyOutcome.ok) {
    if (cleanupErrors.length === 0) throw bodyOutcome.error;
    const primaryMessages = extractErrorMessages(bodyOutcome.error);
    const wrapped = new AggregateError(
      [bodyOutcome.error, ...cleanupErrors.map((message) => new Error(message))],
      `${primaryMessages.join("; ")}; cleanup errors: ${cleanupErrors.join("; ")}`,
    );
    wrapped.cause = bodyOutcome.error;
    throw wrapped;
  }
  return { bodyResult: bodyOutcome.value, cleanupErrors };
}

export function removeDirectorySafely(dirPath, label) {
  try {
    rmSync(dirPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`${label} failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
