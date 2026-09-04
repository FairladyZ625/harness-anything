import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalEventWritePlan, makeTaskEventStore, makeTaskProjection } from "../../../packages/kernel/src/index.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { nav } from "./helpers.mjs";

/**
 * #2225 会话页:状态筛选 + 按缺失原因命名的 unattributed 三桶。
 *
 * 种法(resident-daemon 的 beforeRestart 钩子,与 triadic-ledger 同一条夹具路):
 * 直接向 canonical 事件流 append 真实的 agent-runtime 事件——GUI 随后读到的是
 * daemon 从这些事件投影出来的会话,不是页面 mock。三个会话覆盖三种成因:
 *
 *   runtime_e2e_notask   有 dispatch_requested 记录(无 stream header,taskId 回落
 *                        "unattributed")、无 task 绑定、退出+失败 → `unattributed:no-task`
 *                        (dispatch 存在但没名字叫谁,桶按缺失的东西命名,dec_054C39DA…)。
 *   runtime_e2e_free     只有 started(live)→ `unattributed:no-dispatch`,状态 running。
 *   runtime_e2e_bound    task_bound 到夹具任务 + 退出 + 成功 → task 组,状态 succeeded。
 *
 * 派工行(readSessionGroupDispatches)要求 dispatchId 形如 dispatch_[a-f0-9]{24},
 * 否则读面抛「dispatch id is invalid」——id 全部用合法形状。
 * outcome 事件带 result claim + 内容 blob:SessionsPanel 的精确读会取 result 文本,
 * 缺 blob 会让那条读红。
 */
const identity = (key) => createHash("sha256").update(`gui-e2e-catalog\0${key}`).digest("hex"),
  // 派工行读面要求 dispatch_[a-f0-9]{24};会话 id 用 runtime_ + 24 hex,与 runtimeIngress 同一形状。
  SESSION_NOTASK = `runtime_${identity("no-task").slice(24, 48)}`,
  SESSION_FREE = `runtime_${identity("free").slice(24, 48)}`,
  SESSION_BOUND = `runtime_${identity("bound").slice(24, 48)}`,
  DISPATCH_NOTASK = `dispatch_${identity("no-task").slice(0, 24)}`,
  FIXTURE_TASK = "task-gui-smoke",
  REPO = "gui-e2e-catalog";

const definitionSnapshot = (instanceId, installationId) => ({
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId,
  installationId,
  kindId: "codex",
  providerId: "openai",
  model: "gpt-e2e",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
});

/** 夹具种子:在 daemon 停机窗口里追加 agent-runtime 事件(lanes.mjs 的 beforeRestart 调用)。 */
export async function seedGuiE2eRuntimeSessions(rootDir, repoId) {
  const store = makeTaskEventStore({ rootDir, repoId }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    actor = { principal: { personId: "person-gui" }, executor: null },
    claim = (body) => {
      const sha256 = createHash("sha256").update(body).digest("hex");
      return { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" };
    };
  const append = (type, payload, blobs = []) => {
    const revision = (store.readHead()?.revision ?? 0) + 1,
      opId = `gui-e2e-sessions-${type}-${revision}`,
      event = {
        schema: "agent-runtime-event/v1",
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        workspaceRevision: revision,
        opId,
        type,
        actor,
        source: "local",
        occurredAt: new Date().toISOString(),
        payload,
      };
    store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", opId), blobs });
    projection.apply(event);
  };
  try {
    const notaskBody = "gui-e2e unattributed no-task session failed its probe\n",
      notaskClaim = claim(notaskBody),
      boundBody = "gui-e2e task-bound session succeeded its probe\n",
      boundClaim = claim(boundBody);
    // A:dispatch_requested(无 stream header)→ 派工行 taskId 回落 "unattributed" → no-task 桶。
    append("runtime_dispatch_requested", {
      dispatchId: DISPATCH_NOTASK,
      runtimeSessionId: SESSION_NOTASK,
      instanceId: "instance-e2e-notask",
      installationId: "installation-e2e-notask",
      kindId: "codex",
      idempotencyKey: "gui-e2e-notask",
      definitionSnapshotRef: "provider:definition/e2e-notask",
      definitionSnapshot: definitionSnapshot("instance-e2e-notask", "installation-e2e-notask"),
    });
    append("runtime_session_started", {
      runtimeSessionId: SESSION_NOTASK,
      instanceId: "instance-e2e-notask",
      installationId: "installation-e2e-notask",
      kindId: "codex",
      definitionSnapshotRef: "provider:definition/e2e-notask",
      launchGeneration: 1,
      attachable: false,
    });
    append("runtime_session_exited", { runtimeSessionId: SESSION_NOTASK });
    append(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId: SESSION_NOTASK,
        outcome: "failed",
        exitCode: 1,
        resultRef: `artifact:runtime-result/sha256/${notaskClaim.sha256}`,
        result: notaskClaim,
      },
      [{ ...notaskClaim, body: notaskBody }],
    );
    // B:裸 started(live)→ no-dispatch 桶,状态 running。
    append("runtime_session_started", {
      runtimeSessionId: SESSION_FREE,
      instanceId: "instance-e2e-free",
      installationId: "installation-e2e-free",
      kindId: "codex",
      definitionSnapshotRef: "provider:definition/e2e-free",
      launchGeneration: 1,
      attachable: false,
    });
    // C:task_bound 到夹具任务 → task 组,退出 + 成功。
    append("runtime_session_started", {
      runtimeSessionId: SESSION_BOUND,
      instanceId: "instance-e2e-bound",
      installationId: "installation-e2e-bound",
      kindId: "codex",
      definitionSnapshotRef: "provider:definition/e2e-bound",
      launchGeneration: 1,
      attachable: false,
    });
    append("runtime_session_task_bound", {
      runtimeSessionId: SESSION_BOUND,
      taskId: FIXTURE_TASK,
      executionId: "exe-e2e-bound",
      providerSessionId: "provider-e2e-bound",
      transcriptRef: "file:transcript/e2e-bound.log",
    });
    append("runtime_session_exited", { runtimeSessionId: SESSION_BOUND });
    append(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId: SESSION_BOUND,
        outcome: "succeeded",
        exitCode: 0,
        resultRef: `artifact:runtime-result/sha256/${boundClaim.sha256}`,
        result: boundClaim,
      },
      [{ ...boundClaim, body: boundBody }],
    );
  } finally {
    projection.close();
    await store.drain();
  }
}

/** 从 Electron 主进程环境拿隔离 lane 的 daemon 端点与仓 id(driver 把它们注入 app env)。 */
async function isolatedDaemonTarget(app) {
  const env = await app.evaluate(() => ({
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  }));
  assert.ok(env.endpoint, "the isolated daemon endpoint is missing from the app environment");
  assert.ok(env.repoId, "the isolated repo id is missing from the app environment");
  return env;
}

async function sessionTotals(endpoint, repoId, groupBy) {
  const response = await requestDaemonJsonRpcAt(
    endpoint,
    "repo.projection.read",
    {
      repo: { repoId },
      payload: { name: "runtime-session-groups", groupBy, since: new Date(0).toISOString() },
    },
    8_000,
  );
  assert.equal(response.ok, true, `runtime-session-groups read failed for ${groupBy}`);
  return response.projection.totals;
}

export default {
  id: "sessions-grouping",
  feature: "sessions",
  lane: "isolated",
  description:
    "Seeded runtime sessions group into reason-named unattributed buckets, the status filter narrows the list and says so, and totals.sessions agree across group-by dimensions.",
  async run({ page, app }) {
    // 隔离 daemon 的仓先 warming 后 attached:分组读在 warming 期会被拒(bootstrap_failed)
    // 且 react-query 只重试一次。先等系统读面说仓已挂载,再进会话页。
    const deadline = Date.now() + 20_000;
    for (;;) {
      const attached = await page.evaluate(
        async ({ repoId }) => {
          const repos = (await globalThis.harness.getSystemStatus()).repos ?? [];
          return repos.some((repo) => repo.repoId === repoId && repo.cellState === "attached");
        },
        { repoId: REPO },
      );
      if (attached) break;
      if (Date.now() > deadline) throw new Error(`the isolated repo ${REPO} never reached cellState=attached`);
      await page.waitForTimeout(500);
    }
    await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");

    // 1. 按缺失原因命名的桶 + task 组:判别式在 key(dec_054C39DA50CAD4D4E0D62B726E)。
    await page.getByTestId(`session-group-${FIXTURE_TASK}`).waitFor();
    await page.getByTestId("session-group-unattributed:no-task").waitFor();
    await page.getByTestId("session-group-unattributed:no-dispatch").waitFor();

    // 2. 状态筛选:开启后列表只剩该状态,计数行把「筛选已开」说出来。
    await page.getByTestId("sessions-status-failed").click();
    await page.getByTestId("session-group-unattributed:no-task").waitFor();
    assert.equal(
      await page.getByTestId(`session-group-${FIXTURE_TASK}`).count(),
      0,
      "the failed filter must remove the succeeded session's task group",
    );
    assert.equal(
      await page.getByTestId("session-group-unattributed:no-dispatch").count(),
      0,
      "the failed filter must remove the running session's no-dispatch group",
    );
    const counts = await page.getByTestId("sessions-counts").innerText();
    assert.match(counts, /已按状态筛选|filtered to/u, "the counts line must say the status filter is on");

    // 3. 关掉筛选:列表回到全部桶。
    await page.getByTestId("sessions-status-failed").click();
    await page.getByTestId(`session-group-${FIXTURE_TASK}`).waitFor();
    await page.getByTestId("session-group-unattributed:no-dispatch").waitFor();

    // 4. 各维度 totals.sessions 相等:对照 daemon 的 runtime-session-groups 读命令。
    const { endpoint, repoId } = await isolatedDaemonTarget(app);
    const byDimension = new Map(
      await Promise.all(
        ["task", "squad", "agent", "day"].map(async (groupBy) => [
          groupBy,
          await sessionTotals(endpoint, repoId, groupBy),
        ]),
      ),
    );
    const sessions = byDimension.get("task").sessions;
    assert.ok(sessions >= 3, `expected at least the 3 seeded sessions, read ${sessions}`);
    for (const [groupBy, totals] of byDimension)
      assert.equal(
        totals.sessions,
        sessions,
        `totals.sessions for groupBy=${groupBy} (${totals.sessions}) must match groupBy=task (${sessions})`,
      );
  },
};
