import { spawn } from "node:child_process";

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
