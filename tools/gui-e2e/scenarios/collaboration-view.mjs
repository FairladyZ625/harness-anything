import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileTaskLifecycleWrite,
  lifecycleDocumentFetchPaths,
  makeTaskEventStore,
  makeTaskProjection,
  reduceTaskEvent,
} from "../../../packages/kernel/src/index.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { guiE2eDispatchId, guiE2eRuntimeSessionId } from "./sessions-grouping.mjs";
import { bridgeReady, nav } from "./helpers.mjs";

/**
 * 协作页(task_1bafbf09 返工)的真实 daemon 场景:同一中心读面上区分指派资格与
 * 实际执行。种子全走真实通道——任务/指派经 repo.task.create / repo.task.assign
 * RPC,lease 经停机窗口里向 canonical 台账追加 execution_started 事件(与
 * sessions-grouping 同一条夹具路),执行会话直接复用它种下的会话与派工行:
 *
 *   task-collab-helm   指派 person-ada;lease held,person-ada +
 *                      runtime-session:<round-4 会话>(glm 的最新轮,groupBy=agent
 *                      投影映射得到声明 Agent),来源节点是超长 id 的 edge-alpha。
 *   task-collab-relay  指派 person-bo;lease held,person-bo + <single-1 会话>
 *                      (astra 的最新轮),来源节点 edge-beta。
 *   task-collab-signal 指派 person-ada;lease orphaned,person-ada + <free 会话>
 *                      (无派工行,投影映射不上 → 行内「Agent 未提供」),本机通道。
 *
 * 场景先在默认 local 模式断言入口隐藏,再经 daemon.repo.update 切 remote-center
 * 验证单执行节点的中心仓也能看到协作页(不以节点数量判),跑筛选/跳转/长 ID/宽窄
 * 截图,最后把仓切回 local 并重载,不影响同 lane 的后续场景。
 */
const REPO = "gui-e2e-catalog",
  TASK_HELM = "task-collab-helm",
  TASK_RELAY = "task-collab-relay",
  TASK_SIGNAL = "task-collab-signal",
  SESSION_GLM_LATEST = guiE2eRuntimeSessionId("round-4"),
  SESSION_ASTRA_LATEST = guiE2eRuntimeSessionId("single-1"),
  SESSION_UNMAPPED = guiE2eRuntimeSessionId("free"),
  NODE_ALPHA = "edge-alpha-cluster-fleet-0123456789abcdef",
  NODE_BETA = "edge-beta-desk-42";

/** beforeStop 窗口(daemon 在跑):任务走真实 create,指派走真实 assign RPC(目标账号
 * 由 lanes 的 keycloakSetup 预先登记;节点只作 lease 来源,不走注册——额外注册节点
 * 会挤掉 task-assignment 场景的下拉 index-1 断言)。 */
export async function seedGuiE2eCollaborationTasks(endpoint, repoId) {
  const titles = [
    [TASK_HELM, "舰队协作：指派与执行的同一份中心快照"],
    [TASK_RELAY, "边缘中继：跨节点执行与指派资格"],
    [TASK_SIGNAL, "失联信号：orphaned lease 不算执行中"],
  ];
  for (const [taskId, title] of titles) {
    const created = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId, title } },
      5_000,
    );
    assert.equal(created.ok, true, `collaboration task ${taskId} create failed: ${JSON.stringify(created)}`);
  }
  const list = async () =>
    requestDaemonJsonRpcAt(endpoint, "repo.tasks.list", { repo: { repoId }, payload: {} }, 1_000, 10_000);
  const assign = async (taskId, payload) => {
    let revision;
    for (let round = 0; round < 20; round += 1) {
      const rows = (await list()).rows;
      revision = rows.find((row) => row.taskId === taskId)?.snapshot.revision;
      if (revision !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(revision !== undefined, `task ${taskId} never reached the tasks projection`);
    const assigned = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.assign",
      { repo: { repoId }, payload: { taskId, expectedVersion: revision, ...payload } },
      1_000,
      10_000,
    );
    assert.equal(assigned.ok, true, `assign ${taskId} failed: ${JSON.stringify(assigned)}`);
  };
  await assign(TASK_HELM, { personId: "person-ada", expiresAt: "2099-01-01T00:00:00.000Z" });
  await assign(TASK_RELAY, { personId: "person-bo", expiresAt: "2099-01-01T00:00:00.000Z" });
  await assign(TASK_SIGNAL, { personId: "person-ada", expiresAt: "2099-01-01T00:00:00.000Z" });
}

/** beforeRestart 窗口(daemon 停机):向台账追加 execution_started,lease 携带结构化的
 * actor(executor=runtime-session)/source(node)/phase。事件只过 replay 的 schema 校验,
 * 与 sessions-grouping 的 agent-runtime 种子同一 append 通道。 */
export async function seedGuiE2eCollaborationLeases(rootDir, repoId, writerFence) {
  // 派工流头:runtime 写侧每次派工都会落 .harness/runtime/dispatches/<id>.jsonl,
  // groupBy=agent 的权威 agentId 绑定就在这个头里(sessions-grouping 只种事件与归档,
  // 不对流头,它的组因此全是 Direct)。给两个被引用的轮次补上真实形状的流头,
  // 使 lease 执行会话能映射到声明 Agent;无流头的 free 会话保持未映射。
  const dispatchesRoot = path.join(rootDir, ".harness", "runtime", "dispatches");
  mkdirSync(dispatchesRoot, { recursive: true });
  for (const [key, taskId, instanceId, startedAt, executionId, agentId, agentName] of [
    ["round-4", "task-e2e-rounds", "instance-e2e-rounds", "2026-10-02T13:30:00.000Z", "exe-round-4", "glm", "GLM-5.3"],
    [
      "single-1",
      "task-e2e-single",
      "instance-e2e-single",
      "2026-10-02T11:00:00.000Z",
      "exe-single-1",
      "astra",
      "Astra",
    ],
  ]) {
    const dispatchId = guiE2eDispatchId(key),
      header = {
        schema: "runtime-dispatch-stream/v1",
        kind: "dispatch",
        dispatchId,
        taskId,
        executionId,
        runtimeSessionId: guiE2eRuntimeSessionId(key),
        instanceId,
        startedAt,
        eventStreamRef: `file:.harness/runtime/dispatches/${dispatchId}.jsonl`,
        agentId,
        agentName,
      };
    writeFileSync(path.join(dispatchesRoot, `${dispatchId}.jsonl`), `${JSON.stringify(header)}\n`);
  }
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    leases = [
      {
        taskId: TASK_HELM,
        actor: {
          principal: { personId: "person-ada" },
          executor: { kind: "agent", id: `runtime-session:${SESSION_GLM_LATEST}` },
        },
        source: { kind: "node", nodeId: NODE_ALPHA },
        phase: "held",
      },
      {
        taskId: TASK_RELAY,
        actor: {
          principal: { personId: "person-bo" },
          executor: { kind: "agent", id: `runtime-session:${SESSION_ASTRA_LATEST}` },
        },
        source: { kind: "node", nodeId: NODE_BETA },
        phase: "held",
      },
      {
        // orphaned 是读侧派生(execution_started 只落 held):held 且已过 TTL 的 lease
        // 在 repo.tasks.list 读回 orphaned(持有人在但失联,不算执行中)。
        taskId: TASK_SIGNAL,
        actor: {
          principal: { personId: "person-ada" },
          executor: { kind: "agent", id: `runtime-session:${SESSION_UNMAPPED}` },
        },
        source: "local",
        phase: "held",
        expiredAt: "2026-01-01T00:00:00.000Z",
      },
    ];
  try {
    for (const lease of leases) {
      const read = projection.read(lease.taskId);
      assert.ok(read?.snapshot?.task, `task ${lease.taskId} missing from projection before lease seed`);
      const revision = (store.readHead()?.revision ?? 0) + 1,
        executionId = `exe-collab-${lease.taskId}`,
        task = {
          ...read.snapshot.task,
          status: "active",
          currentNode: "implementation",
          pinned: read.snapshot.task.pinned ?? false,
        },
        event = {
          schema: "task-event/v1",
          eventId: `event-collab-${createHash("sha256").update(lease.taskId).digest("hex").slice(0, 16)}`,
          workspaceRevision: revision,
          opId: `op-collab-${lease.taskId}`,
          taskId: lease.taskId,
          type: "execution_started",
          actor: lease.actor,
          source: "local",
          occurredAt: new Date().toISOString(),
          payload: {
            task,
            execution: {
              schema: "execution/v1",
              executionId,
              taskId: lease.taskId,
              nodeId: "implementation",
              iteration: task.iteration ?? 0,
              state: "active",
              actor: lease.actor,
              claimedAt: new Date().toISOString(),
              submittedAt: null,
              closedAt: null,
              submission: null,
            },
            lease: {
              schema: "lease/v1",
              taskId: lease.taskId,
              executionId,
              actor: lease.actor,
              source: lease.source,
              phase: lease.phase,
              expiresAt: lease.expiredAt ?? "2099-01-01T00:00:00.000Z",
              ttlMs: 1_800_000,
              version: 1,
            },
            previousHolder: null,
            leaseExpiresAt: lease.expiredAt ?? "2099-01-01T00:00:00.000Z",
            reason: "initial_claim",
            documentClaims: [],
          },
        };
      // 与 daemon 写路同源(repo-cell-task-command-docs):replay 收敛下一快照,按事件
      // 声明的文档路径取当前文档,compileTaskLifecycleWrite 产出 store 认可的
      // lifecycle 写计划(事件+文档 claims+租约投影)再 append。
      const next = reduceTaskEvent(read.snapshot, event),
        packagePath = read.packagePath ?? `tasks/${lease.taskId}`,
        documents = lifecycleDocumentFetchPaths(event, packagePath).flatMap((path) => {
          const document = projection.readDocument(path).document;
          return document === null ? [] : [document];
        }),
        compiled = compileTaskLifecycleWrite({ event, snapshot: next, packagePath, currentDocuments: documents });
      store.append({ event: compiled.event, plan: compiled.plan, blobs: compiled.blobs });
      projection.apply(compiled.event, compiled.plan);
      const after = projection.read(lease.taskId);
      assert.deepEqual(after.snapshot.lease?.actor, lease.actor, `lease for ${lease.taskId} did not land`);
      assert.equal(after.snapshot.lease?.phase, lease.expiredAt === undefined ? "held" : "orphaned");
    }
  } finally {
    projection.close();
    await store.drain();
  }
}

export default {
  id: "collaboration-view",
  feature: "collaboration",
  lane: "isolated",
  description:
    "Local mode hides the fleet collaboration entry; a single-execution-node center repo shows it, with assignee vs lease holder, declared agents from the session-groups projection (unmapped sessions say so), node summaries with unknown online status, filters that match visible rows, entity jumps, and wide/narrow screenshots.",
  async run({ page, shot, fixture }) {
    const repoId = fixture?.repoId ?? REPO,
      endpoint = fixture.endpoint,
      rpc = (method, params) => requestDaemonJsonRpcAt(endpoint, method, params, 5_000, 15_000);
    await bridgeReady(page);
    await waitForAttached(page, repoId);

    // 1. 纯本地:入口按仓库模式隐藏(不以节点数量判)。
    assert.equal(
      await page.getByRole("button", { name: /^(?:协作|Collaboration)$/u }).count(),
      0,
      "the collaboration nav entry must stay hidden for a local-mode repo",
    );

    // 2. 切 remote-center:中心单执行节点也能管理协作(同一份中心读面)。
    const updated = await rpc("daemon.repo.update", { repoId, mode: "remote-center" });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    await page.reload();
    await bridgeReady(page);
    await waitForAttached(page, repoId);
    await nav(page, /^(?:协作|Collaboration)$/, "collaboration-view");
    await page.getByTestId("repo-mode-badge-remote-center").first().waitFor();

    // 3. 行内容:资格侧与执行侧同框,Agent 来自投影的权威映射,缺映射如实「未提供」。
    const helmRow = page.locator('[data-testid="collaboration-row"][data-task-id="task-collab-helm"]');
    await helmRow.waitFor();
    // Agent 索引是一条异步读面(groupBy=agent):等它落定再断言行内容,未映射行也因此可判。
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="collaboration-row"][data-task-id="task-collab-helm"]')
          ?.textContent?.includes("GLM-5.3") === true,
      undefined,
      { timeout: 20_000 },
    );
    const helmText = await helmRow.innerText();
    assert.match(helmText, /person-ada/u, "helm row must show the assignee person");
    assert.match(helmText, new RegExp(NODE_ALPHA.slice(0, 12), "u"), "helm row must show the long lease node id");
    assert.match(helmText, /执行中/u, "helm lease is held");
    const relayRow = page.locator('[data-testid="collaboration-row"][data-task-id="task-collab-relay"]');
    assert.match(await relayRow.innerText(), /Astra/u, "relay row maps the astra agent");
    const signalRow = page.locator('[data-testid="collaboration-row"][data-task-id="task-collab-signal"]');
    const signalText = await signalRow.innerText();
    assert.match(
      signalText,
      /Agent 未提供/u,
      "an executor session without a dispatch row must not be attributed to an agent",
    );
    assert.match(signalText, /失联/u, "orphaned lease phase is lost-contact, not executing");
    // 页头执行中只认 held/reserving:两个 held,orphaned 不计。
    const summary = await page.locator('[data-testid="collaboration-view"]').innerText();
    assert.match(summary, /2 执行中/u, `header executing count must be 2 (held only): ${summary.slice(0, 120)}`);

    // 4. 筛选:Agent 维度的计数等于命中的行数;节点汇总如实「在线状态未知」。
    const agentChip = page.getByTestId("collaboration-filter-agent").locator("span[title='glm']").locator("xpath=..");
    await agentChip.click();
    await page
      .locator('[data-testid="collaboration-row"][data-task-id="task-collab-relay"]')
      .waitFor({ state: "detached" });
    assert.equal(
      await page.locator('[data-testid="collaboration-row"]').count(),
      1,
      "agent filter must keep only the glm row",
    );
    await page.getByTestId("collaboration-filter-agent").locator("button").first().click();
    await page.locator('[data-testid="collaboration-row"][data-task-id="task-collab-relay"]').waitFor();
    const nodesStrip = await page.getByTestId("collaboration-nodes").innerText();
    assert.match(nodesStrip, /在线状态未知/u, "node online status must stay unknown without an authoritative read");

    // 5. 跳转:任务详情与会话页(会话跳转保留)。
    await page.getByTestId("collaboration-task-task-collab-helm").click();
    await page.getByText("舰队协作：指派与执行的同一份中心快照").first().waitFor();
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: /^(?:协作|Collaboration)$/u })
      .click();
    await page.getByTestId("collaboration-view").waitFor();
    await page.locator(`button[title*="${SESSION_GLM_LATEST}"]`).first().click();
    await page.waitForFunction(
      (sessionId) =>
        globalThis.document.querySelector('[data-testid="sessions-view"]')?.textContent?.includes(sessionId),
      SESSION_GLM_LATEST,
      { timeout: 15_000 },
    );

    // 6. 总览紧凑入口:真实摘要 + 一键进协作页。
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: /^(?:总览|Overview)$/u })
      .click();
    const entry = page.getByTestId("overview-collaboration-entry");
    await entry.waitFor();
    assert.match(await entry.innerText(), /协作/u);
    await entry.click();
    await page.getByTestId("collaboration-view").waitFor();

    // 7. 宽窄两档截图(1440/1120),收尾恢复视口与仓库模式。
    const originalViewport = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    for (const width of [1440, 1120]) {
      await page.setViewportSize({ width, height: originalViewport.height });
      await page.getByTestId("collaboration-view").waitFor();
      await shot(`collaboration-${width}`);
    }
    await page.setViewportSize(originalViewport);
    // 先回总览再恢复 local:重载后的历史恢复落在总览,不落在已隐藏的协作页。
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: /^(?:总览|Overview)$/u })
      .click();
    await page.getByTestId("overview-view").waitFor();
    const restored = await rpc("daemon.repo.update", { repoId, mode: "local" });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    await page.reload();
    await bridgeReady(page);
    await waitForAttached(page, repoId);
    assert.equal(
      await page.getByRole("button", { name: /^(?:协作|Collaboration)$/u }).count(),
      0,
      "the collaboration entry must hide again after restoring local mode",
    );
  },
};

async function waitForAttached(page, repoId) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const attached = await page.evaluate(async (id) => {
      const repos = (await globalThis.harness.getSystemStatus()).repos ?? [];
      return repos.some((repo) => repo.repoId === id && repo.cellState === "attached");
    }, repoId);
    if (attached) return;
    if (Date.now() > deadline) throw new Error(`the isolated repo ${repoId} never reached cellState=attached`);
    await page.waitForTimeout(500);
  }
}
