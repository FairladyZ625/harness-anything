// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ownedTreeTerminationAdapter } from "./node-test-file-scheduler.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("owned-tree termination uses one POSIX adapter for macOS and Linux", () => {
  assert.equal(ownedTreeTerminationAdapter("darwin"), "posix-owned-process-group");
  assert.equal(ownedTreeTerminationAdapter("linux"), "posix-owned-process-group");
  assert.equal(ownedTreeTerminationAdapter("win32"), "windows-taskkill-tree");
});

test("terminating the runner also terminates its detached test process group", {
  skip: process.platform === "win32"
    ? "POSIX process groups own detached test descendants"
    : false
}, async (context) => {
  const childEnv = {
    ...process.env,
    HARNESS_LOCAL_SLOTS: "64",
    HARNESS_RUNNER_STALL_FIXTURE: "wedge",
    HARNESS_TEST_CONCURRENCY: "1",
    HARNESS_TEST_STALL_DIAGNOSTIC_MS: "250",
    HARNESS_TEST_STALL_ABORT_WINDOWS: "100"
  };
  delete childEnv.NODE_TEST_CONTEXT;

  let output = "";
  let testHostPid;
  const runner = spawn(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-stall/wedged-module.test.mjs",
    "--test-timeout", "60000"
  ], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  runner.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  runner.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  context.after(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    if (testHostPid !== undefined) killProcessGroup(testHostPid, "SIGKILL");
  });

  testHostPid = await waitForValue(() => {
    const parsed = Number(/\[node-test-stall\].+test host pid=(\d+)/u.exec(output)?.[1]);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }, 10_000, () => output);

  const close = waitForClose(runner, 5_000, () => output);
  assert.equal(runner.kill("SIGTERM"), true, output);
  assert.deepEqual(await close, { code: null, signal: "SIGTERM" }, output);
  await waitForValue(
    () => processGroupExists(testHostPid) ? null : true,
    5_000,
    () => output
  );
});

test("terminating the production scheduler reaps every direct worker tree", {
  skip: process.platform === "win32"
    ? "POSIX process groups provide the direct multi-worker identity check"
    : false
}, async (context) => {
  const pidRoot = mkdtempSync(path.join(tmpdir(), "ha-production-file-workers-"));
  const childEnv = {
    ...process.env,
    HARNESS_LOCAL_SLOTS: "64",
    HARNESS_FILE_WORKER_FIXTURE: "parent-signal",
    HARNESS_FILE_WORKER_PID_ROOT: pidRoot,
    HARNESS_TEST_CONCURRENCY: "2"
  };
  delete childEnv.NODE_TEST_CONTEXT;
  let output = "";
  const runner = spawn(process.execPath, [
    "tools/run-node-tests.mjs",
    "--fixture", "tools/test-fixtures/.runner-signal/parent-signal-a.test.mjs",
    "--fixture", "tools/test-fixtures/.runner-signal/parent-signal-b.test.mjs",
    "--test-timeout", "60000"
  ], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  runner.stdout.on("data", (chunk) => { output += chunk.toString(); });
  runner.stderr.on("data", (chunk) => { output += chunk.toString(); });
  context.after(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    rmSync(pidRoot, { recursive: true, force: true });
  });

  const records = await waitForValue(() => {
    const files = readdirSync(pidRoot).filter((file) => file.endsWith(".json"));
    if (files.length !== 2) return null;
    return files.map((file) => JSON.parse(readFileSync(path.join(pidRoot, file), "utf8")));
  }, 10_000, () => output);
  const close = waitForClose(runner, 5_000, () => output);
  assert.equal(runner.kill("SIGTERM"), true, output);
  assert.deepEqual(await close, { code: null, signal: "SIGTERM" }, output);
  await waitForValue(
    () => records.every(({ workerPid, descendantPid }) =>
      !processExists(workerPid) && !processExists(descendantPid)) ? true : null,
    5_000,
    () => `${output}\n${JSON.stringify(records)}`
  );
});

function waitForClose(child, timeoutMs, diagnostic) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child did not close within ${timeoutMs}ms\n${diagnostic()}`));
    }, timeoutMs);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function waitForValue(read, timeoutMs, diagnostic) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms\n${diagnostic()}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function killProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
