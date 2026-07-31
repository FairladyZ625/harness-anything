import { spawn } from "node:child_process";
import { registeredTestIsolationIdentityMatches } from "./node-test-isolation-registry.mjs";

const PROCESS_TREE_KILL_GRACE_MS = 2_000;

export function terminateWindowsProcessTree(child) {
  if (child.pid === undefined) return;
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  killer.once("error", () => child.kill("SIGKILL"));
}

export function forceTerminateProcessTree(pid) {
  if (process.platform !== "win32") return Promise.resolve(signalProcess(pid, "SIGKILL"));
  return new Promise((resolveTermination) => {
    let settled = false;
    let deadline;
    const finish = (terminated) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveTermination(terminated);
    };
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    deadline = setTimeout(() => {
      killer.kill("SIGKILL");
      finish(signalProcess(pid, "SIGKILL"));
    }, PROCESS_TREE_KILL_GRACE_MS);
    killer.once("error", () => finish(signalProcess(pid, "SIGKILL")));
    killer.once("close", (code) => finish(code === 0 || !processIsAlive(pid)));
  });
}

export async function reapPostCompletionChild({
  hostPid,
  isolationChildPid,
  file,
  identity,
  probeIdentity,
  captureDiagnostics,
  terminateProcessTree = forceTerminateProcessTree
}) {
  console.error(
    `\n[node-test-stall] isolation child pid=${isolationChildPid} completed reporter summary for ${file}; collecting diagnostics before post-completion reap`
  );
  await captureDiagnostics();
  if (
    identity !== undefined
    && !await registeredTestIsolationIdentityMatches(
      { pid: isolationChildPid, ppid: hostPid, identity },
      { probeIdentity }
    )
  ) {
    console.error(
      `[node-test-stall] post-completion child pid=${isolationChildPid} no longer matches its registered process identity; skipping termination`
    );
    return false;
  }
  const reaped = await terminateProcessTree(isolationChildPid);
  if (reaped) {
    console.error(
      `[node-test-stall] reaped post-completion child pid=${isolationChildPid} file=${file} termination=${process.platform === "win32" ? "taskkill" : "SIGKILL"}`
    );
  } else {
    console.error(
      `[node-test-stall] post-completion child pid=${isolationChildPid} exited before forced termination; no result override recorded`
    );
  }
  return reaped;
}

export async function terminateLingeringPosixProcessGroup(pid) {
  if (process.platform === "win32" || pid === undefined || !signalProcessGroup(pid, "SIGTERM")) return false;
  console.error("node --test completed with lingering descendants; terminating its process tree");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_TREE_KILL_GRACE_MS));
  signalProcessGroup(pid, "SIGKILL");
  return true;
}

export function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
