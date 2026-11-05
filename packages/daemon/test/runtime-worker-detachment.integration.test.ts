// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { pathToFileURL } from "node:url";

test(
  "a launcher can exit while its detached runtime host continues",
  { skip: process.platform === "win32" ? "requires POSIX detached process-group semantics" : false },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-detached-runtime-"));
    const dispatchId = "dispatch_111111111111111111111111";
    const streamRoot = path.join(parent, ".harness", "runtime", "dispatches");
    mkdirSync(streamRoot, { recursive: true });
    writeFileSync(path.join(streamRoot, `${dispatchId}.jsonl`), "{}\n");
    const script = path.join(parent, "launcher.mjs");
    const moduleUrl = pathToFileURL(path.resolve("packages/daemon/src/runtime-spawn-process.ts")).href;
    writeFileSync(
      script,
      `import { launchNative } from ${JSON.stringify(moduleUrl)};\nimport { watch, existsSync } from "node:fs";\nconst ready = ${JSON.stringify(path.join(parent, "provider-ready"))};\nconst runtime = launchNative({ executablePath: process.execPath, args: ["-e", 'process.stdin.resume(); process.stdin.once("end", () => require("fs").writeFileSync(process.argv[1], "ready")); setInterval(() => {}, 1000)', ready], env: process.env, cwd: ${JSON.stringify(parent)}, prompt: "hold" }, { rootDir: ${JSON.stringify(parent)}, dispatchId: ${JSON.stringify(dispatchId)} });\nawait new Promise(resolve => { const watcher = watch(${JSON.stringify(parent)}, () => { if (existsSync(ready)) { watcher.close(); resolve(); } }); if (existsSync(ready)) { watcher.close(); resolve(); } });\nprocess.stdout.write(String(runtime.pid) + "\\n");\n`,
    );
    const launcher = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let workerPid = 0;
    try {
      const [chunk] = await once(launcher.stdout!, "data");
      workerPid = Number(String(chunk).trim());
      assert.ok(workerPid > 0);
      const closed = once(launcher, "exit");
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("launcher stayed alive while runtime was running")), 3000);
        timer.unref();
      });
      const [code] = await Promise.race([closed, timeout]);
      assert.equal(code, 0);
      assert.doesNotThrow(() => process.kill(workerPid, 0));
    } finally {
      launcher.kill("SIGKILL");
      if (workerPid) terminateWorker(workerPid);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

function terminateWorker(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
