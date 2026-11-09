import { spawn } from "node:child_process";
import { once } from "node:events";
import type { TestContext } from "node:test";
import type { RuntimeProcess } from "../../src/runtime-spawn-types.ts";

/** Synthetic provider output with a real, test-owned process group and an OS exit witness. */
export function runtimeProcessFixture(t: TestContext): Pick<RuntimeProcess, "pid" | "onExit" | "terminate"> & {
  readonly exit: (code: number | null) => void;
} {
  const child = spawn(process.execPath, ["-e", "process.on('message', code => process.exit(code));"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  if (child.pid === undefined) throw new Error("Runtime fixture did not create a process.");
  let exitRequested = false;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    pid: child.pid,
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


export function fixtureRuntimeProcess(context: Pick<TestContext, "after">) {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdin.once('data', () => process.exit(0)); process.stdin.resume()"],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  if (!child.pid) throw new Error("fixture runtime did not expose a pid");
  const terminate = () => {
    if (!child.stdin.writableEnded) child.stdin.end("stop");
  };
  const terminateTree = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    terminate();
    await exited;
  };
  context.after(terminateTree);
  return { pid: child.pid, terminate, terminateTree };
}
