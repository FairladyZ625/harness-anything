// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveE2EProbeElectronForTest, runE2EProbeJourney } from "../../../tools/e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

// GUI 是人的本地查看器,不是派工执行体:自动入口(capture.mjs / e2e probe / gui-e2e lane)
// 从任务派工内启动应用时,环境里的 HARNESS_EXECUTION_CREDENTIAL 必须被主进程在建立
// 第一条 daemon 连接前丢弃,否则 daemon 客户端把它附到每个请求上,按「超出派工作用域」
// 拒绝(execution_credential_rejected),窗口停在 DaemonStartupGate,侧栏永不出现
// (F-7CB70CD4:capture.mjs 等 app-sidebar 30s 超时)。
test(
  "GUI main process drops the ambient worker execution credential before its first daemon request",
  { timeout: 180_000 },
  async (t) => {
    const testRuntime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!testRuntime.available) {
      t.skip(testRuntime.reason);
      return;
    }
    t.after(testRuntime.close);
    const fixture = await startGuiResidentDaemonFixture({
      prefix: "ha-e2e-probe-ambient-credential-",
      daemonId: "e2e-probe-ambient",
      repoId: "e2e-probe-ambient",
      task: { taskId: "task-e2e-probe-ambient", title: "Probe ambient execution credential drop" },
    });
    t.after(fixture.stop);
    // 形状与 runtime-spawn-context 注入的一致,值是假的:夹具 Keycloak 必须拒绝它,
    // 只有主进程丢弃该变量、以本机会话连接,应用才能完成启动。
    const dispatchedWorkerEnv = {
      ...testRuntime.env,
      ...fixture.env,
      HARNESS_DAEMON_ENDPOINT: fixture.endpoint,
      HARNESS_EXECUTION_CREDENTIAL:
        "harness-execution-dispatch_ambient0000000000000000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const result = await runE2EProbeJourney({
      workspaceRoot,
      rootDir: fixture.rootDir,
      env: dispatchedWorkerEnv,
      // 预热会用同一份 env 起 CLI,而 CLI 侧附着凭据被拒属于 runner 进程那一半同类
      // 泄漏,不是本测试的边界;夹具种子已把投影写热,无需预热。
      warmDaemon: false,
    });

    assert.equal(result.outcome, "healthy", JSON.stringify(result));
    assert.deepEqual(result.completedSteps, [
      "bridge_ready",
      "task_projection",
      "board",
      "task_detail",
      "task_dispatch",
      "sessions",
      "agent_squad",
      "navigation_history",
    ]);
  },
);
