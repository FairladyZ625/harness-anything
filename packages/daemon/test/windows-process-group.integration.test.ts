// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream, readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { launchNative } from "../src/runtime-spawn-process.ts";
import { runtimePidIsAlive } from "../src/runtime-process-liveness.ts";
import { probeProcessGroup, reconcileProcessGroup } from "../src/runtime/process-group-reconciler.ts";

for (const stop of ["sweep", "host-exit"] as const)
  test(
    `Windows ${stop} proves an orphan grandchild stopped through the persisted job`,
    {
      skip: process.platform !== "win32" ? "requires Windows Job Objects" : false,
      timeout: 90_000,
    },
    async () => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "ha-windows-job-")),
        dispatchId = "dispatch_454545454545454545454545",
        providerPath = path.join(rootDir, "provider.mjs");
      // The intermediate exits before the readiness event. A later PPID walk cannot find this
      // grandchild, and detached:true exercises inheritance through libuv's own nested jobs.
      const intermediate = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
        {detached:true,stdio:'ignore',windowsHide:true});
      child.unref();process.send(child.pid,()=>process.disconnect());`;
      writeFileSync(
        providerPath,
        `import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],
        {stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
      let grandchild;child.on('message',pid=>grandchild=pid);
      child.on('exit',()=>console.log(JSON.stringify({type:'thread.started',thread_id:'job-test',grandchild})));
      setInterval(()=>{},1000);`,
      );
      openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId: "runtime_454545454545454545454545",
        instanceId: "job-test",
        taskId: null,
        executionId: null,
        startedAt: new Date().toISOString(),
        kindId: "codex",
      });
      let runtime: ReturnType<typeof launchNative> | undefined;
      try {
        runtime = launchNative(
          {
            executablePath: process.execPath,
            args: [providerPath],
            cwd: rootDir,
            env: process.env,
            prompt: "test",
          } as never,
          { rootDir, dispatchId },
        );
        const exited = new Promise<void>((resolve) => runtime!.onExit(() => resolve())),
          grandchild = await new Promise<number>((resolve) =>
            runtime!.onOutput((chunk) => {
              const event = JSON.parse(chunk) as { grandchild?: number };
              if (event.grandchild) resolve(event.grandchild);
            }),
          ),
          identity = { pid: runtime.pid, dispatch: { rootDir, dispatchId } };
        assert.equal(runtimePidIsAlive(grandchild), true);
        assert.ok(
          readDispatchStreamSummary(rootDir, dispatchId)!.records.some(
            (record) => record.kind === "process_containment",
          ),
        );
        assert.equal(probeProcessGroup(identity), "running");
        if (stop === "sweep") reconcileProcessGroup(identity);
        else process.kill(runtime.pid);
        await exited;
        const deadline = Date.now() + 15_000;
        while (probeProcessGroup(identity) !== "proven_stopped") {
          assert.ok(Date.now() < deadline, "job accounting did not reach zero");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(runtimePidIsAlive(grandchild), false);
      } finally {
        if (runtime) {
          await runtime.terminateTree?.();
          runtime.release?.();
        }
        rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
  );
