import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { releaseDaemonPidFile } from "../../src/daemon-singleton.ts";
import { launchNative } from "../../src/runtime-spawn-process.ts";
import { startDaemon } from "../../src/runtime.ts";

const [userRoot, rootDir, runtimeFile, providerReady] = process.argv.slice(2) as [string, string, string, string];
const daemonId = "superseded-pid-holder",
  dispatchId = "dispatch_111111111111111111111111";
const streamRoot = path.join(rootDir, ".harness", "runtime", "dispatches");
mkdirSync(streamRoot, { recursive: true });
writeFileSync(path.join(streamRoot, `${dispatchId}.jsonl`), "{}\n");
const worker = launchNative(
  {
    executablePath: process.execPath,
    args: [
      "-e",
      'process.stdin.resume(); process.stdin.once("end", () => require("fs").writeFileSync(process.argv[1], "ready")); setInterval(() => {}, 1000)',
      providerReady,
    ],
    env: process.env,
    cwd: rootDir,
    prompt: "hold",
  },
  { rootDir, dispatchId },
);
process.on("message", () => undefined);
process.once("exit", () => releaseDaemonPidFile(userRoot, daemonId, process.pid));
const daemon = await startDaemon({
  userRoot,
  daemonId,
  runtimeFile,
  ...{ retainPidUntilExit: true },
  onSupersededExit: () => {
    process.send!("released");
  },
});
if (!("stop" in daemon)) throw new Error("fixture failed to acquire singleton");
process.send!({ ready: true, workerPid: worker.pid });
