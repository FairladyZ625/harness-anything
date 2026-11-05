// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLocalDaemonRunning } from "../src/client/daemon-autostart.ts";
import { daemonServiceUnit } from "../src/client/daemon-service.ts";

function terminateFakeManager(pidPath: string): void {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8"));
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test(
  "a stuck service-manager start cannot indefinitely hold daemon handoff",
  { skip: process.platform === "win32" ? "requires POSIX executable fixture and process groups" : false },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ha-service-start-timeout-")),
      userRoot = path.join(directory, "user"),
      target = { userRoot, daemonId: "default" },
      unit = daemonServiceUnit(target, process.platform, directory)!,
      script = path.join(directory, unit.manager === "launchd" ? "launchctl" : "systemctl"),
      pidPath = path.join(directory, "manager.pid");
    mkdirSync(path.dirname(unit.unitPath), { recursive: true });
    writeFileSync(unit.unitPath, "isolated fixture\n");
    writeFileSync(
      script,
      `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nrequire("fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    chmodSync(script, 0o755);
    const originalPath = process.env.PATH,
      originalHome = process.env.HOME;
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    process.env.HOME = directory;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const start = ensureLocalDaemonRunning({
        socketPath: path.join(directory, "daemon.sock"),
        invokingRoot: directory,
        launch: () => ({
          command: process.execPath,
          args: ["index.js", "--service", "--user-root", userRoot, "--daemon-id", target.daemonId],
          env: process.env,
        }),
        probe: async () => false,
        readyTimeoutMs: 1000,
        probeIntervalMs: 10,
      });
      const result = await Promise.race([
        start,
        new Promise<"hung">((resolve) => {
          timer = setTimeout(() => resolve("hung"), 8000);
        }),
      ]);
      assert.equal(existsSync(pidPath), true, "the fake manager must have started");
      assert.notEqual(result, "hung", "the start budget must bound a stuck service manager");
      assert.equal(typeof result === "object" && result.code, "daemon_start_failed");
      const managerPid = Number(readFileSync(pidPath, "utf8"));
      assert.throws(() => process.kill(managerPid, 0), { code: "ESRCH" }, "the timed-out manager must be reaped");
    } finally {
      clearTimeout(timer);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      terminateFakeManager(pidPath);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
