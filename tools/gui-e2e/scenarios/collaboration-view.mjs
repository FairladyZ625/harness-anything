import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compileTaskLifecycleWrite,
  lifecycleDocumentFetchPaths,
  makeTaskEventStore,
  makeTaskProjection,
  reduceTaskEvent,
} from "../../../packages/kernel/src/index.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { guiE2eRuntimeSessionId } from "./sessions-grouping.mjs";
import { bridgeReady, nav } from "./helpers.mjs";

/**
 * 协作页(task_1bafbf09 返工)的真实 daemon 场景:同一中心读面上区分指派资格与
 * 实际执行。种子全走真实通道——任务/指派经 repo.task.create / repo.task.assign
 * RPC,lease 经停机窗口里向 canonical 台账追加 execution_started 事件(与
 * sessions-grouping 同一条夹具路),执行会话直接复用它种下的会话与派工行:
 *
 *   task-collab-helm   指派 person-ada;lease held,person-ada +
 *                      runtime-session:<round-4 会话>(仓库派工事件声明 glm),来源节点是超长 id 的 edge-alpha。
 *   task-collab-relay  指派 person-bo;lease held,person-bo + <single-1 会话>
 *                      (仓库派工事件声明 astra),来源节点 edge-beta。
 *   task-collab-signal 指派 person-ada;lease orphaned,person-ada + <free 会话>
 *                      (无声明 Agent,行内「Agent 未提供」),本机通道。
 *
 * 场景先在默认 local 模式断言入口隐藏,再经 daemon.repo.update 切 remote-center
 * 验证单执行节点的中心仓也能看到协作页(不以节点数量判),跑筛选/跳转/长 ID/宽窄
 * 截图,最后把仓切回 local 并重载,不影响同 lane 的后续场景。
 */
const TASK_HELM = "task-collab-helm",
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
    "The fleet topology Collaboration page backed by repo.fleet.overview.read: daemon-served nodes (center + lease-holding edges) on the redesigned SVG command canvas (state-colored links, drawer details with cut progress), event stream filtered by node with click-to-node, task jumps, reduced-motion and motion-evidence screenshots, and an animation probe proving zero React re-renders while CSS animations run.",
  async run({ page, shot, fixture }) {
    await bridgeReady(page);
    await waitForAttached(page, fixture.repoId);

    // 1. 本地仓(本机即中心)也能进协作页:入口不按模式隐藏,页面给出中心提示条。
    await nav(page, /^(?:协作|Collaboration)$/, "collaboration-view");
    await page.getByTestId("collaboration-center-notice").waitFor();

    // 2. 拓扑节点来自 daemon 聚合:中心 + 两个 lease 来源边缘,无中生有的节点不出现;
    //    重做后的 SVG 连线层每个边缘一条状态连线(isolated 台账无副本行 → absent 灰虚线)。
    await page.getByTestId("collaboration-node-center").waitFor({ timeout: 20_000 });
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).waitFor();
    await page.getByTestId(`collaboration-node-${NODE_BETA}`).waitFor();
    const header = await page.getByTestId("collaboration-view").innerText();
    assert.match(header, /3 节点/u, `topology must show center plus two lease-source edges: ${header.slice(0, 120)}`);
    assert.match(header, /2 执行中/u, "executing counts held/reserving leases only, not the orphaned one");
    const linkCount = await page.locator("g.fleet-link[data-state]").count();
    assert.equal(linkCount, 2, "the SVG link layer renders one state-colored link per edge node");
    assert.equal(
      await page.locator('g.fleet-link[data-state="absent"]').count(),
      2,
      "edges without a replica row get the gray dashed absent link",
    );

    // 3. 边缘节点详情(右侧滑入抽屉):在做什么 = 租约任务/人/会话/phase;内部状态如实「未提供」带人话原因。
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).click();
    await page.getByRole("dialog").waitFor();
    const details = page.getByTestId("collaboration-node-details");
    await details.waitFor();
    const detailText = await details.innerText();
    assert.match(detailText, /舰队协作：指派与执行的同一份中心快照/u, "the held lease task is listed under its node");
    assert.match(detailText, /person-ada/u, "the lease principal is shown");
    assert.match(detailText, /执行中/u, "the held lease phase renders as executing");
    assert.match(detailText, /未提供/u, "fields the read cannot see say so");
    assert.match(
      detailText,
      /中心未在此读面暴露节点 TLS 会话事实/u,
      "the unavailable reason reads as a human sentence",
    );
    // 机器码不进可见文本,只保留在 data-reason/title 供断言与诊断。
    assert.doesNotMatch(detailText, /tls-session-fact-not-exposed/u, "machine codes stay out of visible text");
    await details.locator('[data-reason="tls-session-fact-not-exposed"]').waitFor();
    // 详情底部的读面声明渲染为人话图例,不再露出 key=value 调试串。
    const notesText = await page.getByTestId("collaboration-read-notes").innerText();
    assert.match(notesText, /事件按任务当前租约归属节点/u, "the notes legend is humanized");
    assert.doesNotMatch(notesText, /events-attribution=/u, "no raw key=value debug strings");
    // 抽屉面板会盖住右侧节点卡:交互前先收起,等退出动画结束。
    await page.getByTestId("collaboration-node-details-close").click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 });

    // 4. 中心节点详情:daemon 构建、本机租约(orphaned 显示失联,不算执行中)。
    await page.getByTestId("collaboration-node-center").click();
    await page.getByTestId("collaboration-task-task-collab-signal").waitFor();
    assert.match(
      await page.getByTestId("collaboration-node-details").innerText(),
      /失联/u,
      "an orphaned lease keeps its lost-contact phase",
    );
    await page.getByTestId("collaboration-node-details-close").click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 });

    // 5. 事件流按节点过滤,点事件跳到对应节点详情。
    const filter = page.getByTestId("collaboration-event-filter");
    await filter.selectOption(NODE_ALPHA);
    // 行 testid 是 collaboration-event-evt-<id>:前缀要带上 evt-,否则会先命中筛选下拉自身。
    const eventRows = page.locator('[data-testid^="collaboration-event-evt-"]');
    const visible = await eventRows.count();
    assert.ok(visible > 0, "the filtered node has events in the canonical window");
    for (let index = 0; index < visible; index += 1)
      assert.match(
        await eventRows.nth(index).innerText(),
        new RegExp(NODE_ALPHA.slice(0, 12), "u"),
        "filtered events must all carry the selected node",
      );
    await eventRows.first().click();
    await page.waitForFunction(
      (nodeId) =>
        globalThis.document
          .querySelector(`[data-testid="collaboration-node-${nodeId}"]`)
          ?.getAttribute("aria-pressed") === "true",
      NODE_ALPHA,
      { timeout: 10_000 },
    );

    // 6. 跳转:详情里的任务点击进任务详情,再回协作页。
    await page.getByTestId("collaboration-task-task-collab-helm").click();
    await page.getByText("舰队协作：指派与执行的同一份中心快照").first().waitFor();
    await page
      .getByTestId("app-sidebar-scroll")
      .getByRole("button", { name: /^(?:协作|Collaboration)$/u })
      .click();
    await page.getByTestId("collaboration-view").waitFor();

    // 7. 宽窄两档截图(1440/1120),加过滤态与 390 窄屏,收尾恢复视口。
    const originalViewport = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    for (const width of [1440, 1120]) {
      await page.setViewportSize({ width, height: originalViewport.height });
      await page.getByTestId("collaboration-view").waitFor();
      await shot(`collaboration-${width}`);
    }
    // 1440 节点详情(边缘节点点开)单独留档,随后收起抽屉再截过滤态与窄屏。
    await page.setViewportSize({ width: 1440, height: originalViewport.height });
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).click();
    await page.getByTestId("collaboration-node-details").waitFor();
    await shot("collaboration-detail-1440");
    await page.getByTestId("collaboration-node-details-close").click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 });
    // 节点过滤态(事件流只留该节点)单独留档。
    await filter.selectOption(NODE_ALPHA);
    await shot("collaboration-filtered-1440");
    await filter.selectOption("all");
    // 390 窄屏:Electron 最小窗口宽度可能托底,如实按实际宽度截图。
    await page.setViewportSize({ width: 390, height: originalViewport.height });
    await shot("collaboration-overview-390");
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).click();
    await page.getByTestId("collaboration-node-details").waitFor();
    await shot("collaboration-detail-390");
    await page.getByTestId("collaboration-node-details-close").click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 });
    await page.setViewportSize(originalViewport);

    // 8. 动效证据(task_16c20131):视口切换后先等拓扑几何沉降(重排引发的属性写
    //    不属于动画成本),再采样 2s 稳态窗口——动画推进走 CSS 时间轴,窗口内 DOM
    //    零变更(= 动画期间 0 次 React 重渲染);连拍三帧留档流光/呼吸/扫描环的推进。
    await page.setViewportSize({ width: 1440, height: originalViewport.height });
    await page.getByTestId("collaboration-view").waitFor();
    for (let round = 0; ; round += 1) {
      assert.ok(round < 12, "the topology geometry never settles after the viewport change");
      const churn = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const seen = [];
            const observer = new globalThis.MutationObserver((records) => seen.push(...records));
            observer.observe(globalThis.document.querySelector('[data-testid="collaboration-view"]'), {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
            globalThis.setTimeout(() => {
              observer.disconnect();
              resolve(seen.length);
            }, 350);
          }),
      );
      if (churn === 0) break;
    }
    const perf = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const animations = globalThis.document.getAnimations().filter((a) => a.playState === "running");
          const before = animations.map((a) => a.currentTime);
          const mutations = [];
          const samples = [];
          const observer = new globalThis.MutationObserver((records) => {
            mutations.push(...records);
            for (const record of records)
              if (samples.length < 8)
                samples.push(
                  `${record.type}:${record.target instanceof globalThis.Element ? record.target.tagName.toLowerCase() : "text"}:${record.attributeName ?? ""}`,
                );
          });
          // 只看协作页本体:应用外壳(侧栏状态轮询等)的变更不属于拓扑动画的成本。
          const scope = globalThis.document.querySelector('[data-testid="collaboration-view"]');
          observer.observe(scope, { subtree: true, childList: true, attributes: true, characterData: true });
          const startedAt = performance.now();
          globalThis.setTimeout(() => {
            const after = animations.map((a) => a.currentTime);
            observer.disconnect();
            resolve({
              running: animations.length,
              advanced: after.some((time, index) => time !== null && before[index] !== null && time > before[index]),
              mutations: mutations.length,
              samples,
              windowMs: performance.now() - startedAt,
            });
          }, 2000);
        }),
    );
    assert.ok(perf.running > 0, `CSS animations (breathe/scan/event-in) are running: ${JSON.stringify(perf)}`);
    assert.ok(perf.advanced, `animations advance on the wall-clock timeline: ${JSON.stringify(perf)}`);
    assert.equal(
      perf.mutations,
      0,
      `no DOM mutations while animations run (zero React re-renders): ${JSON.stringify(perf)}`,
    );
    for (let frame = 1; frame <= 3; frame += 1) {
      await shot(`collaboration-motion-frame-${frame}`);
      if (frame < 3) await page.waitForTimeout(700);
    }

    // 9. reduced-motion:系统偏好「减少动态效果」下动画全部关停,静态状态色仍在。
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await page.evaluate(() => globalThis.document.getAnimations().filter((a) => a.playState === "running").length),
      0,
      "prefers-reduced-motion stops every topology animation",
    );
    const absentLinks = await page.locator('g.fleet-link[data-state="absent"]').count();
    assert.ok(absentLinks > 0, "static state colors survive reduced motion");
    await shot("collaboration-reduced-motion-1440");
    await page.emulateMedia({ reducedMotion: "no-preference" });
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
