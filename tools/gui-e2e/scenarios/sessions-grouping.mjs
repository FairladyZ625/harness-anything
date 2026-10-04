import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalEventWritePlan,
  compileEntityDocumentRematerialization,
  makeTaskEventStore,
  makeTaskProjection,
  OPAQUE_TEXTUAL_POLICY_ID,
} from "../../../packages/kernel/src/index.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { assertUnscrolledLayout, nav } from "./helpers.mjs";

/**
 * #2225 会话页:状态筛选 + 按缺失原因命名的 unattributed 三桶。
 * task_666b2539 增补:任务组/轮次层次 fixture——两个新任务组,其一 4 轮同名 agent
 * (运行/成功/取消/成功),其一单轮,连同既有 task-gui-smoke 组共 3 个任务组。
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
 * 层次 fixture 的 agent 名与轮次排序来自任务包里的派工归档 JSON
 * (artifacts/dispatches/<dispatchId>.json,readTaskDispatches 的 settled archive 路径);
 * 事件流只承载 liveness/状态。派工行(readSessionGroupDispatches)要求 dispatchId 形如
 * dispatch_[a-f0-9]{24},否则读面抛「dispatch id is invalid」——id 全部用合法形状。
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
  REPO = "gui-e2e-catalog",
  /** 夹具会话 id 的确定性派生(协作场景按同一公式引用已种会话,见 collaboration-view.mjs)。 */
  guiE2eRuntimeSessionId = (key) => `runtime_${identity(key).slice(24, 48)}`,
  /** 夹具派工 id 的确定性派生(dispatch_[a-f0-9]{24},与轮次行同一来源)。 */
  guiE2eDispatchId = (key) => `dispatch_${identity(key).slice(0, 24)}`,
  /** 层次 fixture:task-e2e-rounds 的 4 轮(数组序=轮次序,第 4 轮最新)。最新轮 failed
   * 留在活跃区,其余终态沉底——夹具 daemon 重启会把停机窗口种的会话标 unknown
   * (markRuntimeSessionsUnknown),live/running 态种不出来;真实运行态由 canonical
   * 只读截图覆盖。 */
  ROUNDS_TASK = "task-e2e-rounds",
  SINGLE_TASK = "task-e2e-single",
  roundsFixture = [
    { key: "round-4", status: "failed", agent: "GLM-5.3", startedAt: "2026-10-02T13:30:00.000Z" },
    { key: "round-3", status: "succeeded", agent: "GLM-5.3", startedAt: "2026-10-02T13:00:00.000Z" },
    { key: "round-2", status: "cancelled", agent: "GLM-5.3", startedAt: "2026-10-02T12:30:00.000Z" },
    { key: "round-1", status: "succeeded", agent: "GLM-5.3", startedAt: "2026-10-02T12:00:00.000Z" },
  ],
  singleFixture = [{ key: "single-1", status: "succeeded", agent: "Astra", startedAt: "2026-10-02T11:00:00.000Z" }],
  roundIds = (rows) =>
    Object.fromEntries(
      rows.map((row) => [
        row.key,
        {
          dispatchId: `dispatch_${identity(row.key).slice(0, 24)}`,
          runtimeSessionId: `runtime_${identity(row.key).slice(24, 48)}`,
        },
      ]),
    ),
  ROUNDS = roundIds(roundsFixture);

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

/** 夹具种子:在 daemon 停机窗口里追加 agent-runtime 事件(lanes.mjs 的 beforeRestart 调用)。
 * taskPackages 是 seedGuiE2eSessionTasks 返回的 taskId → packagePath——派工归档要落
 * 在真实包路径(create 派生目录名),不是 tasks/<taskId>。 */
/** 协作场景(collaboration-view.mjs)按同一确定性公式引用已种会话与派工 id。 */
export { guiE2eRuntimeSessionId, guiE2eDispatchId };

export async function seedGuiE2eRuntimeSessions(rootDir, repoId, writerFence, taskPackages = {}) {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
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
    // D:层次 fixture——两个新任务组(seedGuiE2eSessionTasks 已在 beforeStop 窗口建好
    // 任务实体)。每轮一对 dispatch_requested + session 事件(状态真相);派工归档
    // JSON(agent 名与 startedAt 排序真相)按生产同路——entity-document 事件发布成
    // 投影文档(doc-sync-publication 的发布形态),文件树同字节落盘。
    const archiveUpdates = [];
    for (const [task, instanceId, rows] of [
      [ROUNDS_TASK, "instance-e2e-rounds", roundsFixture],
      [SINGLE_TASK, "instance-e2e-single", singleFixture],
    ]) {
      for (const row of rows) {
        const { dispatchId, runtimeSessionId } = roundIds([row])[row.key],
          installationId = `installation-${instanceId}`,
          snapshotRef = `provider:definition/${row.key}`,
          archive = {
            schema: "runtime-dispatch/v1",
            dispatchId,
            taskId: task,
            executionId: `exe-${row.key}`,
            runtimeSessionId,
            instanceId,
            agentId: row.agent === "Astra" ? "astra" : "glm",
            agentName: row.agent,
            startedAt: row.startedAt,
            endedAt: row.startedAt,
            outcome: row.status,
            provider: { instance: instanceId, model: "gpt-e2e" },
          },
          archivePath = `${taskPackages[task] ?? `tasks/${task}`}/artifacts/dispatches/${dispatchId}.json`,
          archiveBody = `${JSON.stringify(archive, null, 2)}\n`;
        writeDispatchArchiveBody(rootDir, taskPackages[task] ?? `tasks/${task}`, dispatchId, archiveBody);
        archiveUpdates.push({
          path: archivePath,
          body: archiveBody,
          mediaType: "application/json",
          policyId: OPAQUE_TEXTUAL_POLICY_ID,
        });
        append("runtime_dispatch_requested", {
          dispatchId,
          runtimeSessionId,
          ...(row.key === "round-4"
            ? { agentId: "glm", agentName: "GLM-5.3" }
            : row.key === "single-1"
              ? { agentId: "astra", agentName: "Astra" }
              : {}),
          instanceId,
          installationId,
          kindId: "codex",
          idempotencyKey: `gui-e2e-${row.key}`,
          definitionSnapshotRef: snapshotRef,
          definitionSnapshot: definitionSnapshot(instanceId, installationId),
        });
        append("runtime_session_started", {
          runtimeSessionId,
          instanceId,
          installationId,
          kindId: "codex",
          definitionSnapshotRef: snapshotRef,
          launchGeneration: 1,
          attachable: false,
        });
        append("runtime_session_task_bound", {
          runtimeSessionId,
          taskId: task,
          executionId: `exe-${row.key}`,
          providerSessionId: `provider-${row.key}`,
          transcriptRef: `file:transcript/${row.key}.log`,
        });
        if (row.status !== "running") {
          append("runtime_session_exited", { runtimeSessionId });
          const body = `gui-e2e hierarchy fixture ${row.key} ${row.status}\n`,
            resultClaim = claim(body);
          append(
            "runtime_session_outcome_observed",
            {
              runtimeSessionId,
              outcome: row.status,
              exitCode: row.status === "succeeded" ? 0 : 1,
              resultRef: `artifact:runtime-result/sha256/${resultClaim.sha256}`,
              result: resultClaim,
            },
            [{ ...resultClaim, body }],
          );
        }
      }
    }
    // 归档一次成组发布(readTaskDispatches 只认投影文档,直接落盘文件不进投影)。
    const archiveRevision = (store.readHead()?.revision ?? 0) + 1,
      archiveWrite = compileEntityDocumentRematerialization({
        entityRefs: [`task/${ROUNDS_TASK}`, `task/${SINGLE_TASK}`],
        updates: archiveUpdates,
        rationale: "gui-e2e sessions-grouping hierarchy fixture: settled dispatch archives",
        actor,
        source: "local",
        opId: `gui-e2e-dispatch-archives-${archiveRevision}`,
        occurredAt: new Date().toISOString(),
        workspaceRevision: archiveRevision,
      });
    store.append({ event: archiveWrite.event, plan: archiveWrite.plan, blobs: archiveWrite.blobs });
    projection.apply(archiveWrite.event);
  } finally {
    projection.close();
    await store.drain();
  }
}

/** 层次 fixture 的两个任务组:走 repo.task.create 成为被投影实体(lanes.mjs 在 daemon
 * 停机前的 beforeStop 窗口调用)。返回 taskId → 真实 packagePath——包目录名由
 * create 派生(不等于 tasks/<taskId>),派工归档必须落在真实包路径下。 */
export async function seedGuiE2eSessionTasks(endpoint, repoId) {
  const packagePaths = {};
  for (const [taskId, title] of [
    [ROUNDS_TASK, "恢复可用的性能统计窗口"],
    [SINGLE_TASK, "页面分区换位与紧凑布局"],
  ]) {
    const created = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId, title } },
      5_000,
    );
    assert.equal(created.ok, true, `task fixture ${taskId} create failed: ${JSON.stringify(created)}`);
    packagePaths[taskId] = String(created.packagePath);
  }
  return packagePaths;
}

/** 派工归档落盘(与 entity-document 事件同字节;任务实体由 seedGuiE2eSessionTasks 先建)。 */ function writeDispatchArchiveBody(
  rootDir,
  packagePath,
  dispatchId,
  body,
) {
  const dispatchesDir = path.join(rootDir, "harness", packagePath, "artifacts", "dispatches");
  mkdirSync(dispatchesDir, { recursive: true });
  writeFileSync(path.join(dispatchesDir, `${dispatchId}.json`), body);
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
    "Seeded runtime sessions group into reason-named unattributed buckets, the status filter narrows the list and says so, totals.sessions agree across group-by dimensions, and task groups read as heads over single-line round rows under a guide line.",
  async run({ page, app, runRoot, shot }) {
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

    // 1b. 任务/轮次层次(task_666b2539):先拍同窗口同字号的前后对比素材(宽/窄 ×
    // 浅/深),再断言几何与交互——修前形态上断言必红,截图已先落盘。
    const hierarchyViewport = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    await expandGroup(page, ROUNDS_TASK);
    await expandGroup(page, SINGLE_TASK);
    for (const width of [1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expandGroup(page, ROUNDS_TASK);
      for (const theme of ["light", "dark"]) {
        await setTheme(page, theme);
        await shot(`sessions-hierarchy-${width}-${theme}`);
      }
    }
    await setTheme(page, "light");
    await page.setViewportSize(hierarchyViewport);
    await settleGroupLayout(page);
    const geometry = await hierarchyGeometry(page);
    writeFileSync(path.join(runRoot, "sessions-hierarchy-geometry.json"), `${JSON.stringify(geometry, null, 2)}\n`);
    await assertHierarchyGeometry(page, geometry);
    await assertRoundInteractions(page);

    // Exercise both real responsive controls; a wide-only run cannot catch a hidden inline selector.
    const originalViewport = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    const layouts = [];
    for (const width of [1100, 1440]) {
      await page.setViewportSize({ width, height: originalViewport.height });
      await page
        .getByTestId(width === 1100 ? "sessions-status-filter-menu" : "sessions-status-failed")
        .waitFor({ state: "visible" });
      layouts.push({
        viewportWidth: width,
        layout: await assertUnscrolledLayout(page.getByTestId("sessions-toolbar"), "button, input"),
      });
      await shot(`sessions-toolbar-${width}`);
      // 状态筛选:开启后列表只剩该状态,计数行把「筛选已开」说出来。
      await toggleFailedFilter(page);
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

      // 关掉筛选:列表回到全部桶。
      await toggleFailedFilter(page);
      await page.getByTestId(`session-group-${FIXTURE_TASK}`).waitFor();
      await page.getByTestId("session-group-unattributed:no-dispatch").waitFor();
    }
    await page.setViewportSize(originalViewport);
    writeFileSync(path.join(runRoot, "sessions-toolbar-layout.json"), `${JSON.stringify(layouts, null, 2)}\n`);

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

async function toggleFailedFilter(page) {
  const inline = page.getByTestId("sessions-status-failed");
  if (await inline.isVisible()) {
    await inline.click();
    return;
  }
  await page.getByTestId("sessions-status-filter-menu").click();
  await page.getByTestId("sessions-status-menu-failed").click();
  await page.keyboard.press("Escape");
}

/** 展开一个任务组(已展开则不动):组内轮次行挂上即视为展开完成——旧形态没有
 * 组体容器 testid,等待点不绑在实现细节上。 */
async function expandGroup(page, taskKey) {
  const toggle = page.getByTestId(`session-group-toggle-${taskKey}`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByTestId(`session-group-${taskKey}`).locator('[data-testid^="rail-session-"]').first().waitFor();
}

/** 主题切换走真实设置页;返回会话页并恢复展开,供浅/深两套截图同一数据。 */
async function setTheme(page, theme) {
  if ((await page.locator("html").getAttribute("data-theme")) === theme) return;
  await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
  await page.getByTestId("settings-content").waitFor();
  await page.getByRole("button", { name: /外观|Appearance/u }).click();
  await page.getByRole("button", { name: theme === "light" ? /亮色|Light/u : /暗色|Dark/u }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
  await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");
  await expandGroup(page, ROUNDS_TASK);
  await expandGroup(page, SINGLE_TASK);
}

/** 实测几何(不是类名断言):组头/子行高差、缩进、引导线、字重、行不重叠、标题不溢出。 */
async function hierarchyGeometry(page) {
  return page.evaluate(
    ({ roundsTask, singleTask }) => {
      const measureGroup = (taskKey) => {
        const section = globalThis.document.querySelector(`[data-testid="session-group-${taskKey}"]`),
          header = section?.querySelector('[data-testid="session-group-toggle-' + taskKey + '"] [data-dense-row]'),
          body = section?.querySelector(`[data-testid="session-group-body-${taskKey}"]`),
          // 组头字重量半粗内层 span;溢出量在承担 ellipsis 的标题槽 span 上。
          weightSource = header?.querySelector(".font-semibold"),
          title = header?.querySelector(".truncate.text-text"),
          rows = body ? [...body.querySelectorAll("[data-dense-row]")] : [];
        const box = (node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, top: rect.top, bottom: rect.bottom, height: rect.height };
        };
        return {
          header: header ? box(header) : null,
          headerTitleWeight: weightSource ? globalThis.getComputedStyle(weightSource).fontWeight : null,
          headerTitleOverflow: title ? title.scrollWidth > title.clientWidth + 1 : null,
          bodyLeft: body ? box(body).left : null,
          bodyBorderLeft: body ? globalThis.getComputedStyle(body).borderLeftWidth : null,
          rows: rows.map(box),
          rowTitleWeight: rows[0]?.querySelector(".truncate.text-text")
            ? globalThis.getComputedStyle(rows[0].querySelector(".truncate.text-text")).fontWeight
            : null,
        };
      };
      const rounds = measureGroup(roundsTask),
        // 跨组行按屏幕位置排序后再比相邻(组间顺序与数组顺序无关)。
        flattened = [rounds, measureGroup(singleTask)]
          .flatMap((group) => group.rows)
          .sort((left, right) => left.top - right.top);
      return {
        rounds,
        single: measureGroup(singleTask),
        rowOverlap: flattened.some((row, index) => index > 0 && row.top < flattened[index - 1].bottom - 0.5),
      };
    },
    { roundsTask: ROUNDS_TASK, singleTask: SINGLE_TASK },
  );
}

/** 等虚拟列表收敛:组 section 是绝对定位 translateY 摆放的,展开后 measureElement
 * 异步回填——等所有 section 纵向不叠且轮次行挂齐,再量几何;10s 不收敛即真回归。 */
async function settleGroupLayout(page) {
  await page.waitForFunction(
    ({ roundsTask }) => {
      const sections = [...globalThis.document.querySelectorAll('[data-testid^="session-group-task-"]')].map((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      });
      const stacked = [...sections].sort((left, right) => left.top - right.top);
      const disjoint = stacked.every((box, index) => index === 0 || box.top >= stacked[index - 1].bottom - 0.5);
      const roundsSection = globalThis.document.querySelector(`[data-testid="session-group-${roundsTask}"]`);
      const roundsMounted = roundsSection ? roundsSection.querySelectorAll("[data-dense-row]").length >= 5 : false;
      return disjoint && roundsMounted;
    },
    { roundsTask: ROUNDS_TASK },
    { timeout: 10_000 },
  );
}

async function assertHierarchyGeometry(page, geometry) {
  const rounds = geometry.rounds;
  assert.ok(rounds.header, "the rounds group header row is missing");
  assert.ok(rounds.rows.length >= 4, `expected 4 round rows, measured ${rounds.rows.length}`);
  // 组头 56px 两行;子行 40px 单行——父子不同形,子行更紧凑。
  assert.ok(rounds.header.height >= 50, `group head must stay two-line (>=50px), measured ${rounds.header.height}`);
  for (const [index, row] of rounds.rows.entries())
    assert.ok(
      row.height <= 44 && row.height < rounds.header.height - 8,
      `round row ${index} must be single-line and lighter than the head, measured ${row.height}`,
    );
  // 归属线索:子行容器缩进 + 连续细竖线;灰度/无选中也可辨父子。
  assert.ok(
    (rounds.bodyLeft ?? -1) > rounds.header.left + 8,
    `round rows must indent under the head (head ${rounds.header.left}, body ${rounds.bodyLeft})`,
  );
  assert.ok(
    Number.parseFloat(rounds.bodyBorderLeft ?? "0") >= 1,
    `the round container must draw a guide line, borderLeftWidth=${rounds.bodyBorderLeft}`,
  );
  // 字重分层:组头半粗,子行常规——不靠字号解决层次。
  assert.ok(
    Number(rounds.headerTitleWeight) > Number(rounds.rowTitleWeight),
    `head title must outweigh round title (${rounds.headerTitleWeight} vs ${rounds.rowTitleWeight})`,
  );
  assert.equal(geometry.rowOverlap, false, "expanded round rows must not overlap after virtualizer layout");
  assert.equal(rounds.headerTitleOverflow, false, "the long task title must truncate, not overflow");
  assert.equal(geometry.single.headerTitleOverflow, false, "the single-round task title must truncate, not overflow");
}

/** 交互证据:点第 2 轮精确选中、Task 入口跳对、收起不误选、检索返回正确轮次。 */
async function assertRoundInteractions(page) {
  const body = page.getByTestId(`session-group-body-${ROUNDS_TASK}`),
    round2Id = ROUNDS["round-2"].runtimeSessionId,
    round1Id = ROUNDS["round-1"].runtimeSessionId;
  // 活跃轮(第 4 轮 failed)在上、终态沉到已完成小标签之后:行序 = 第 4 轮 → divider → 第 3/2/1 轮。
  const sequence = await body.evaluate((node) =>
    [...node.querySelectorAll('[data-testid^="rail-session-"], [data-testid="completed-divider"]')].map((element) => ({
      testid: element.dataset.testid,
      text: element.textContent,
    })),
  );
  assert.deepEqual(
    sequence.map((row) => row.testid),
    [
      `rail-session-${ROUNDS["round-4"].runtimeSessionId}`,
      "completed-divider",
      `rail-session-${ROUNDS["round-3"].runtimeSessionId}`,
      `rail-session-${round2Id}`,
      `rail-session-${round1Id}`,
    ],
    JSON.stringify(sequence, null, 2),
  );

  const round2 = body.locator(`[data-testid="rail-session-${round2Id}"]`);
  assert.match(await round2.innerText(), /第 2 轮|Round 2/u);
  await round2.click();
  await page.waitForFunction(
    (id) => globalThis.document.querySelector('[data-testid="sessions-detail"]')?.textContent?.includes(id),
    round2Id,
  );
  assert.equal(await round2.getAttribute("aria-current"), "true");
  assert.equal(await round2.locator("[data-dense-row]").getAttribute("data-selected"), "true");

  // 收起不误选:组体卸载,右侧详情仍是第 2 轮的会话。
  await page.getByTestId(`session-group-toggle-${ROUNDS_TASK}`).click();
  await page.getByTestId(`session-group-body-${ROUNDS_TASK}`).waitFor({ state: "detached" });
  assert.ok(
    (await page.getByTestId("sessions-detail").textContent())?.includes(round2Id),
    "collapsing the group must not change the selected session",
  );
  await expandGroup(page, ROUNDS_TASK);

  // Task 入口归组操作位:跳到 task-e2e-rounds 的详情,再回会话页(任务详情头部也有
  // 「Sessions」入口,回程导航限定侧栏作用域)。
  await page
    .getByTestId(`session-group-body-${ROUNDS_TASK}`)
    .locator("button", { hasText: /Task 详情|Task detail/u })
    .click();
  await page.getByText("恢复可用的性能统计窗口").first().waitFor();
  await page
    .getByTestId("app-sidebar-scroll")
    .getByRole("button", { name: /^(?:会话|Sessions)$/u })
    .click();
  await page.getByTestId("sessions-view").first().waitFor();
  await expandGroup(page, ROUNDS_TASK);

  // 检索仍返回正确轮次:按 dispatch id 检索,命中组的该轮可见,别的组退场(轮次行
  // 检索前就可见,以无关组退场为过滤生效的等待点)。
  await page.getByTestId("sessions-search").fill(ROUNDS["round-1"].dispatchId);
  await page.getByTestId(`session-group-${SINGLE_TASK}`).waitFor({ state: "detached" });
  assert.equal(await page.getByTestId(`session-group-${FIXTURE_TASK}`).count(), 0);
  await page.getByTestId(`rail-session-${round1Id}`).waitFor();
  await page.getByTestId("sessions-search").fill("");
  await page.getByTestId(`session-group-${SINGLE_TASK}`).waitFor();
}
