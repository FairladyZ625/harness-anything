// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareE2EProbeGui, resolveE2EProbeElectronForTest } from "../e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

test(
  "GUI driver keeps the Electron profile out of the run directory and removes it on close",
  { timeout: 180_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason);
      return;
    }
    t.after(runtime.close);
    prepareE2EProbeGui(workspaceRoot, runtime.env);
    const { startGuiDriver } = await import("./driver.mjs");
    const fixture = await startGuiResidentDaemonFixture({
      prefix: "ha-gui-driver-profile-",
      daemonId: "gui-driver-profile",
      repoId: "gui-driver-profile",
      task: { taskId: "task-gui-driver-profile", title: "Keep the Electron profile out of artifacts" },
    });
    t.after(fixture.stop);
    // 模拟 worker 把运行目录指进任务包产物目录。目录必须放在 os.tmpdir() 之外:profile 若仍从
    // runRoot 派生(本测试锁定的回归),userData 会落在 outDir 下而不是系统临时目录。
    const outDir = path.join(workspaceRoot, ".harness", "gui-e2e-driver-profile-test");
    const runRoot = path.join(outDir, "run");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    t.after(() => rmSync(outDir, { recursive: true, force: true }));
    const isolatedEnv = { ...runtime.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
    delete isolatedEnv.HARNESS_EXECUTION_CREDENTIAL;
    const driver = await startGuiDriver({ workspaceRoot, rootDir: fixture.rootDir, env: isolatedEnv, runRoot });
    // 断言失败也不能泄漏 Electron:不注册这个钩子,一次红会把 node --test 挂在子进程的管道上。
    // 显式 close 之后 playwright 连接已关,二次 close 会抛 TypeError,安全网只兜进程不判重入。
    t.after(() => driver.close().catch(() => undefined));
    // Electron 把 --user-data-dir 开关映射到 app.getPath("userData"),且返回 realpath
    // (macOS 上带 /private 前缀),所以对照 realpathSync 后的系统临时目录。
    const userData = await driver.app.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(
      userData.startsWith(`${realpathSync(tmpdir())}${path.sep}`),
      true,
      `userData ${userData} must live under the os temp directory`,
    );
    await driver.close();
    assert.equal(existsSync(userData), false, `profile ${userData} must be removed when the driver closes`);
    assert.deepEqual(readdirSync(outDir), ["run"], "the output directory must receive only run deliverables");
    assert.deepEqual(readdirSync(runRoot), ["window-state.json"]);
  },
);

test("GUI driver removes its profile directory when the launch fails", { timeout: 60_000 }, async (t) => {
  if (!existsSync(path.join(workspaceRoot, "node_modules", "electron", "path.txt"))) {
    t.skip("The Electron binary is not installed in this environment.");
    return;
  }
  const { startGuiDriver } = await import("./driver.mjs");
  // startGuiDriver 在 os.tmpdir() 下建 profile;把 TMPDIR 指到专用目录后,一次失败的启动
  // 不允许在里面留下任何 hg-profile-* 目录。
  const isolatedTmpdir = mkdtempSync(path.join(tmpdir(), "gui-driver-profile-tmp-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmpdir;
  try {
    const missingWorkspace = path.join(isolatedTmpdir, "missing-workspace");
    await assert.rejects(
      startGuiDriver({
        workspaceRoot: missingWorkspace,
        rootDir: isolatedTmpdir,
        env: process.env,
        runRoot: isolatedTmpdir,
      }),
    );
    assert.deepEqual(
      readdirSync(isolatedTmpdir).filter((entry) => entry.startsWith("hg-profile-")),
      [],
      "a failed launch must not leave a profile directory behind",
    );
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(isolatedTmpdir, { recursive: true, force: true });
  }
});
