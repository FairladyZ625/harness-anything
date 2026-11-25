import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { TestContext } from "node:test";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  openDispatchStream,
} from "../../src/daemon-host/dispatch-stream.ts";
import type { RuntimeProcess } from "../../src/daemon-host/runtime-spawn-types.ts";

export interface FixtureDispatchPersistence {
  readonly rootDir: string;
  readonly dispatchId: string;
}

/**
 * Record a closed Windows Job Object witness for a test-owned runtime that either
 * has no OS process (synthetic stopped PID) or whose test-owned child has already exited.
 * Never call while a real fixture child is still alive.
 */
export function recordStoppedFixtureContainment(
  persistence: FixtureDispatchPersistence | undefined,
  pid: number,
): void {
  if (process.platform !== "win32" || !persistence) return;
  const streamPath = dispatchStreamPath(persistence.rootDir, persistence.dispatchId);
  if (!existsSync(streamPath))
    openDispatchStream(persistence.rootDir, {
      dispatchId: persistence.dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: `fixture-${persistence.dispatchId}`,
      instanceId: "fixture",
      startedAt: new Date().toISOString(),
    });
  appendRuntimeWorkerRecord(persistence.rootDir, persistence.dispatchId, {
    kind: "process_containment",
    occurredAt: new Date().toISOString(),
    pid,
    containmentId: `Global\\HarnessRuntime-fixture-stopped-${randomUUID()}`,
  });
}

/** Synthetic provider output with a real, test-owned process group and an OS exit witness. */
export function runtimeProcessFixture(
  t: TestContext,
  persistence?: FixtureDispatchPersistence,
): Pick<RuntimeProcess, "pid" | "onExit" | "terminate"> & {
  readonly exit: (code: number | null) => void;
} {
  const child = spawn(process.execPath, ["-e", "process.on('message', code => process.exit(code));"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  if (child.pid === undefined) throw new Error("Runtime fixture did not create a process.");
  const pid = child.pid;
  let exitRequested = false,
    containmentRecorded = false;
  const markStopped = () => {
    if (containmentRecorded) return;
    containmentRecorded = true;
    recordStoppedFixtureContainment(persistence, pid);
  };
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      markStopped();
      resolve(code);
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    pid,
    onExit: (listener) => {
      void exited.then(listener);
    },
    exit: (code) => {
      if (exitRequested) return;
      exitRequested = true;
      child.send(code ?? 0);
    },
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

export function fixtureRuntimeProcess(context: Pick<TestContext, "after">, persistence?: FixtureDispatchPersistence) {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()"],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  if (!child.pid) throw new Error("fixture runtime did not expose a pid");
  const pid = child.pid;
  let containmentRecorded = false;
  const markStopped = () => {
    if (containmentRecorded) return;
    containmentRecorded = true;
    recordStoppedFixtureContainment(persistence, pid);
  };
  child.once("exit", markStopped);
  const terminate = () => {
    if (!child.stdin.writableEnded) child.stdin.end("stop");
  };
  const terminateTree = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      terminate();
      await exited;
    }
    markStopped();
  };
  context.after(terminateTree);
  return { pid, terminate, terminateTree };
}
