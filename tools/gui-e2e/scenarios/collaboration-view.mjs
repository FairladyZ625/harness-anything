import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  READ_MODEL_SCHEMA_GENERATION,
  compileTaskLifecycleWrite,
  lifecycleDocumentFetchPaths,
  makeTaskEventStore,
  makeTaskProjection,
  reduceTaskEvent,
  resolveHarnessLayout,
} from "../../../packages/kernel/src/index.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { openReplicaAckStore } from "../../../packages/daemon/src/fleet/replica-ack-store.ts";
import { openReplicaCutSource } from "../../../packages/daemon/src/fleet/replica-cut-store.ts";
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
 *   task-collab-beacon 指派 person-bo;lease held,来源节点 edge-gamma(第 2 轮:
 *                      absent 态的载体,台账无副本行)。
 *
 * 第 2 轮(CEO 检查点)补真实副本通道三态:场景开始时(daemon 空闲、fleet center
 * 尚未启动)向中心自己的副本账本种行——只读打开 checkpoints.sqlite 取最新修订 N 与连续
 * cut 区间,经 openReplicaAckStore 把 ALPHA 的 ack cursor 落在 N(fresh)、BETA 落在
 * 最大连续 N-k(lag≥1),GAMMA 不种(absent=账本无行);再用 openssl 自签证书经
 * daemon.fleet.center.start 启动真实 TLS center,center.status() 从磁盘账本读出
 * 副本行,GUI 的 repo.fleet.overview.read 因此拿到 fresh/lag/absent 三种连线。
 *
 * 场景先在默认 local 模式断言入口隐藏,再经 daemon.repo.update 切 remote-center
 * 验证单执行节点的中心仓也能看到协作页(不以节点数量判),跑筛选/跳转/长 ID/宽窄
 * 截图,最后把仓切回 local 并重载,不影响同 lane 的后续场景。
 */
const TASK_HELM = "task-collab-helm",
  TASK_RELAY = "task-collab-relay",
  TASK_SIGNAL = "task-collab-signal",
  TASK_BEACON = "task-collab-beacon",
  SESSION_GLM_LATEST = guiE2eRuntimeSessionId("round-4"),
  SESSION_ASTRA_LATEST = guiE2eRuntimeSessionId("single-1"),
  SESSION_UNMAPPED = guiE2eRuntimeSessionId("free"),
  NODE_ALPHA = "edge-alpha-cluster-fleet-0123456789abcdef",
  NODE_BETA = "edge-beta-desk-42",
  NODE_GAMMA = "edge-gamma-beacon-77";

/** beforeStop 窗口(daemon 在跑):任务走真实 create,指派走真实 assign RPC(目标账号
 * 由 lanes 的 keycloakSetup 预先登记;节点只作 lease 来源,不走注册——额外注册节点
 * 会挤掉 task-assignment 场景的下拉 index-1 断言)。 */
export async function seedGuiE2eCollaborationTasks(endpoint, repoId) {
  const titles = [
    [TASK_HELM, "舰队协作：指派与执行的同一份中心快照"],
    [TASK_RELAY, "边缘中继：跨节点执行与指派资格"],
    [TASK_SIGNAL, "失联信号：orphaned lease 不算执行中"],
    [TASK_BEACON, "信标节点：从未同步的 absent 通道"],
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
  await assign(TASK_BEACON, { personId: "person-bo", expiresAt: "2099-01-01T00:00:00.000Z" });
}

/** beforeRestart 窗口(daemon 停机):向台账追加 execution_started,lease 携带结构化的
 * actor(executor=runtime-session)/source(node)/phase。事件只过 replay 的 schema 校验,
 * 与 sessions-grouping 的 agent-runtime 种子同一 append 通道。
 * 第 2 轮:同一窗口里把 repo-cell 同款 replica cut source 接上并 activate——本地仓
 * 平时无人激活 cut 账本(只有边缘读会话会 activate),而 fleet 三态需要真实 cut 行;
 * 每笔 append 后等 cut 落行,保证 [latest-k, latest] 连续可服务 delta。 */
export async function seedGuiE2eCollaborationLeases(rootDir, repoId, writerFence) {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    replica = openReplicaCutSource({
      repoId,
      localRoot: path.dirname(path.dirname(projection.path)),
      // 与 repo-cell 同款读序列适配(readSequence/readRevision 口径,a310599ca 起
      // publish 必经 readSequence;旧的 readBasis 选项已不在接口上)。
      readSequence: projection.readReplicaSequence,
      readRevision: projection.readReplicaRevision,
      readLedgerCut: () => store.currentCut(),
      readContentBlob: (sha256) => store.readContentBlob(sha256),
      readEvent: (opId) => store.readEvent(opId),
      readApplied: (opId) => projection.readOperation(opId),
    }),
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
      {
        // 第 2 轮:absent 态载体——持有租约但副本账本无行(从未在本中心同步过)。
        taskId: TASK_BEACON,
        actor: {
          principal: { personId: "person-bo" },
          executor: { kind: "agent", id: `runtime-session:${SESSION_UNMAPPED}` },
        },
        source: { kind: "node", nodeId: NODE_GAMMA },
        phase: "held",
      },
    ];
  try {
    // 激活 cut 账本:初始 cut 落在当前 head;后续每笔 lease append 都追加一条
    // 连续 cut 行(fresh=latest,lag=latest-k 都有真实行可指)。
    const activated = replica.activate();
    assert.ok(activated !== null, "replica cut source produced no initial cut");
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
        // relay 的事件时间前移 9s:lag 节点的 lagMs 由「最新事件时间 − cursor cut 事件时间」
        // 得出,同秒连写会把 lag 秒数压成 0;前移让 lag 状态在卡片上有可见的秒数。
        occurredAt =
          lease.taskId === TASK_RELAY ? new Date(Date.now() - 9_000).toISOString() : new Date().toISOString(),
        event = {
          schema: "task-event/v1",
          eventId: `event-collab-${createHash("sha256").update(lease.taskId).digest("hex").slice(0, 16)}`,
          workspaceRevision: revision,
          opId: `op-collab-${lease.taskId}`,
          taskId: lease.taskId,
          type: "execution_started",
          actor: lease.actor,
          source: "local",
          occurredAt,
          payload: {
            task,
            execution: {
              schema: "execution/v1",
              gateRuns: [],
              executionId,
              taskId: lease.taskId,
              nodeId: "implementation",
              iteration: task.iteration ?? 0,
              state: "active",
              actor: lease.actor,
              claimedAt: occurredAt,
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
      // 等 cut 行落账:每笔 append 之后账本里都有该修订的 cut(delta 链连续)。
      await replica.waitForCut(revision);
      const after = projection.read(lease.taskId);
      assert.deepEqual(after.snapshot.lease?.actor, lease.actor, `lease for ${lease.taskId} did not land`);
      assert.equal(after.snapshot.lease?.phase, lease.expiredAt === undefined ? "held" : "orphaned");
    }
    const latestCut = replica.latest();
    assert.ok(latestCut !== null && latestCut.revision >= 3, "the seeded ledger must carry contiguous cut rows");
  } finally {
    replica.close();
    projection.close();
    await store.drain();
  }
}

/**
 * 第 2 轮(CEO 检查点):给 isolated 夹具种出 fresh/lag/absent 三种副本通道。
 * 前提:daemon 空闲且 fleet center 尚未启动——center 的副本读全走磁盘账本,所以
 * 先种 ack 行、后启 center,顺序不能倒。种法不伪造 daemon 读面:cursor 落在 cuts
 * 账本里真实存在的修订上(fresh=最新修订 N,lag=最大连续前驱 N-k,delta 可服务),
 * digest 取该修订的真实 cut 行;absent 是「不种」(账本无行)。
 */
export async function seedGuiE2eFleetReplicaStates({ endpoint, rootDir, userRoot, repoId }) {
  const cutsPath = path.join(
    resolveHarnessLayout({ rootDir }).localRoot,
    "replica",
    "repos",
    repoId,
    `g${READ_MODEL_SCHEMA_GENERATION}`,
    "checkpoints.sqlite",
  );
  assert.ok(existsSync(cutsPath), `replica cut store missing at ${cutsPath}`);
  const cuts = new DatabaseSync(cutsPath, { readOnly: true });
  let window;
  try {
    // 只读窗口取最近 12 个 cut 行(WAL 允许与运行中的 daemon 并发读)。
    window = cuts
      .prepare(
        "SELECT revision, head_digest, manifest_digest, occurred_at FROM cut " +
          "WHERE revision > (SELECT MAX(revision) - 12 FROM cut) ORDER BY revision",
      )
      .all();
  } finally {
    cuts.close();
  }
  assert.ok(window.length >= 2, `replica cut store has no contiguous window: ${JSON.stringify(window)}`);
  const latest = Number(window[window.length - 1].revision);
  let lagFrom = latest;
  while (lagFrom - 1 >= 1 && window.some((row) => Number(row.revision) === lagFrom - 1) && latest - (lagFrom - 1) < 6)
    lagFrom -= 1;
  assert.ok(lagFrom < latest, `no contiguous predecessor for a lagging cursor (latest=${latest})`);

  const ackStore = openReplicaAckStore(path.join(userRoot, "fleet"));
  try {
    const seedCursor = (nodeId, viewId, revision) => {
      const cut = window.find((row) => Number(row.revision) === revision);
      assert.ok(cut, `cut row ${revision} vanished between read and seed`);
      const key = { nodeId, viewId, repoId },
        transferId = `transfer-e2e-${nodeId}-${revision}`,
        ackedAt = new Date().toISOString(),
        // ack 要求一条活跃的 delivery lease(transport 契约):claim 后同事务内续租生效。
        lease = ackStore.delivery.claim(key, `seed-${nodeId}`, Date.parse(ackedAt), 60_000);
      assert.ok(lease, `seeding ${nodeId} could not claim its delivery lease`);
      ackStore.register(key, 1);
      ackStore.offer(key, {
        transferId,
        fromCut: null,
        toCut: { revision, headDigest: String(cut.head_digest), schemaGeneration: READ_MODEL_SCHEMA_GENERATION },
        manifestDigest: String(cut.manifest_digest),
        kind: "delta",
        issuedAt: new Date().toISOString(),
      });
      const acked = ackStore.ack(
        key,
        transferId,
        { revision, headDigest: String(cut.head_digest), schemaGeneration: READ_MODEL_SCHEMA_GENERATION },
        String(cut.manifest_digest),
        ackedAt,
        String(cut.occurred_at),
        lease,
      );
      assert.equal(acked.outcome, "applied", `seeding ${nodeId} cursor at revision ${revision}`);
    };
    seedCursor(NODE_ALPHA, "view-e2e-alpha", latest);
    seedCursor(NODE_BETA, "view-e2e-beta", lagFrom);
  } finally {
    ackStore.close();
  }

  // 自签证书 + 真实 TLS center:center.status() 从磁盘账本读副本行,GUI 读面因此
  // 看到 ALPHA=fresh / BETA=lag / GAMMA=absent(无行)。
  const tlsDir = mkdtempSync(path.join(tmpdir(), "ha-fleet-e2e-tls-")),
    keyPath = path.join(tlsDir, "tls.key"),
    certPath = path.join(tlsDir, "tls.crt");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const started = await requestDaemonJsonRpcAt(
      endpoint,
      "daemon.fleet.center.start",
      { payload: { port: 0, keyPath, certPath, repoId, quotaBytes: 64 * 1024 * 1024 } },
      5_000,
      60_000,
    );
    assert.equal(started.ok, true, `fleet center start failed: ${JSON.stringify(started)}`);
  } finally {
    // The center reads the key and certificate into memory at startup; the directory itself is
    // throwaway material and is removed here even when startup fails.
    rmSync(tlsDir, { recursive: true, force: true });
  }
  return { latestRevision: latest, lagRevision: lagFrom, lagRevisions: latest - lagFrom };
}

export default {
  id: "collaboration-view",
  feature: "collaboration",
  lane: "isolated",
  description:
    "The fleet topology Collaboration page backed by repo.fleet.overview.read: daemon-served nodes (center + lease-holding edges) on the redesigned SVG command canvas (fresh/lag/absent state-colored links with a live fleet TLS center, drawer details with cut progress), event stream filtered by node with click-to-node, task jumps, reduced-motion and motion-evidence screenshots, and an animation probe proving zero React re-renders while CSS animations run.",
  async run({ page, shot, fixture }) {
    // 第 2 轮:先种副本三态并启动 fleet center(daemon 空闲、center 未启动是前提)。
    const seeded = await seedGuiE2eFleetReplicaStates({
      endpoint: fixture.endpoint,
      rootDir: fixture.rootDir,
      userRoot: fixture.userRoot,
      repoId: fixture.repoId,
    });
    await bridgeReady(page);
    await waitForAttached(page, fixture.repoId);

    // 1. 本地仓(本机即中心)也能进协作页:入口不按模式隐藏,页面给出中心提示条。
    await nav(page, /^(?:协作|Collaboration)$/, "collaboration-view");
    await page.getByTestId("collaboration-center-notice").waitFor();

    // 2. 拓扑节点来自 daemon 聚合:中心 + 三个 lease 来源边缘(超长 id/常规 id/信标),
    //    连线三态同框:ALPHA=fresh(cursor=latest)、BETA=lag(cursor 落后)、GAMMA=absent(账本无行)。
    await page.getByTestId("collaboration-node-center").waitFor({ timeout: 20_000 });
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).waitFor();
    await page.getByTestId(`collaboration-node-${NODE_BETA}`).waitFor();
    await page.getByTestId(`collaboration-node-${NODE_GAMMA}`).waitFor();
    const header = await page.getByTestId("collaboration-view").innerText();
    assert.match(header, /4 节点/u, `topology must show center plus three lease-source edges: ${header.slice(0, 120)}`);
    assert.match(header, /3 执行中/u, "executing counts held/reserving leases only, not the orphaned one");
    assert.equal(
      await page.locator("g.fleet-link[data-state]").count(),
      3,
      "the SVG link layer renders one state-colored link per edge node",
    );
    for (const [state, count] of [
      ["fresh", 1],
      ["lag", 1],
      ["absent", 1],
    ])
      assert.equal(
        await page.locator(`g.fleet-link[data-state="${state}"]`).count(),
        count,
        `the seeded fleet renders a ${state} link (cursor revisions: latest=${seeded.latestRevision}, lag=${seeded.lagRevision})`,
      );
    assert.equal(
      await page.locator(`g.fleet-link[data-node="${NODE_BETA}"] .fleet-link-flow`).count(),
      1,
      "the lagging link carries the flow beam (speed tracks lag)",
    );
    // 第 3 轮:粒子列车与流光同轨更快一档——三帧动效里粒子位移肉眼可辨的前提。
    assert.equal(
      await page.locator(`g.fleet-link[data-node="${NODE_BETA}"] .fleet-link-particles`).count(),
      1,
      "fresh/lag links carry the particle train",
    );
    // 连线可见长度是第 3 轮的一等契约:中心-边缘边框间 ≥120px(SVG 路径全长)。
    const linkLengths = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll("path.fleet-link-base")].map((path) =>
        Math.round(path.getTotalLength()),
      ),
    );
    assert.ok(
      linkLengths.length >= 3 && linkLengths.every((length) => length >= 120),
      `every center-edge link stays visibly long (>=120px): ${JSON.stringify(linkLengths)}`,
    );
    // 第 4 轮回归:节点卡必须完整落在画布可视区内(含底边)——环形态曾在中带宽
    // (1120 窗)需求 659 > 容器 625,底卡被滚动折叠线裁掉。
    await assertNodesInsideCanvas(page);
    // 中心卡是能量核心的读数板:rev/边缘数/在飞数 + 带 head 标签的短 hash。
    const centerCard = await page.getByTestId("collaboration-node-center").innerText();
    assert.match(centerCard, /rev \d+/u, "the center card states the center revision");
    assert.match(centerCard, /边缘 \d+/u, "the center card states the connected edge count");
    assert.match(centerCard, /在飞 \d+/u, "the center card states fleet-wide in-flight executions");
    assert.match(centerCard, /head [0-9a-f]{7,8}/u, "the head hash carries a label and stays truncated");
    // 连线状态图例:四态线样即第一语言,回答「为什么是灰的」。
    const legend = page.getByTestId("collaboration-link-legend");
    await legend.waitFor();
    assert.match(await legend.innerText(), /灰虚线/u, "the legend explains the gray dashed absent link");

    // 3. 边缘节点详情(右侧滑入抽屉):在做什么 = 租约任务/人/会话/phase;内部状态如实「未提供」带人话原因。
    //    第 2 轮修复回归:超长 id 完整可见(换行,不是省略号),面板无横向溢出。
    //    第 3 轮修复:截图与断言必须等滑入动画沉降(transform 归零)——第 2 轮的
    //    「右侧没有内边距」截图实为动画末端面板尚未进屏,内容被窗口右缘裁掉。
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).click();
    await page.getByRole("dialog").waitFor();
    await drawerSettled(page);
    const details = page.getByTestId("collaboration-node-details");
    await details.waitFor();
    await assertDrawerFits(page);
    const detailText = await details.innerText();
    assert.match(detailText, new RegExp(NODE_ALPHA, "u"), "the full long node id stays visible in the drawer");
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
      // 截图前必须等拓扑几何沉降(与抽屉 drawerSettled 同一课):ResizeObserver →
      // React 重排是异步的,不等它,1440 截图会捕到 1120 档的画布几何。
      await topologySettled(page);
      await shot(`collaboration-${width}`);
    }
    // 第 2 轮留档:fresh/lag/absent 三种连线同框的 1440 总览(夹具已种三态副本)。
    await page.setViewportSize({ width: 1440, height: originalViewport.height });
    await page.getByTestId("collaboration-view").waitFor();
    await topologySettled(page);
    await assertNodesInsideCanvas(page);
    await shot("collaboration-link-states-1440");
    // 1440 节点详情(边缘节点点开)单独留档,随后收起抽屉再截过滤态与窄屏。
    await page.setViewportSize({ width: 1440, height: originalViewport.height });
    await page.getByTestId("collaboration-view").waitFor();
    await topologySettled(page);
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).click();
    await page.getByTestId("collaboration-node-details").waitFor();
    await drawerSettled(page);
    await shot("collaboration-detail-1440");
    await page.getByTestId("collaboration-node-details-close").click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 });
    // 节点过滤态(事件流只留该节点)单独留档。
    await filter.selectOption(NODE_ALPHA);
    await shot("collaboration-filtered-1440");
    await filter.selectOption("all");
    // 390 窄屏:Electron 最小窗口宽度可能托底,如实按实际宽度截图;抽屉同样不许溢出。
    await page.setViewportSize({ width: 390, height: originalViewport.height });
    await topologySettled(page);
    await assertNodesInsideCanvas(page);
    await shot("collaboration-overview-390");
    await page.getByTestId(`collaboration-node-${NODE_ALPHA}`).click();
    await page.getByTestId("collaboration-node-details").waitFor();
    await drawerSettled(page);
    await assertDrawerFits(page);
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

/** 拓扑几何沉降:视口切换后 ResizeObserver → React 重排是异步的,不等它,截图与
 * 断言捕到的是旧宽度的布局(第 4 轮:link-states-1440 曾拍下 1120 档的环几何,
 * 画布比容器高,底卡被折叠线裁掉)。等离散条件——内容层宽度吃满当前容器宽。 */
async function topologySettled(page) {
  await page.waitForFunction(
    () => {
      const container = globalThis.document.querySelector('[data-testid="collaboration-topology"]');
      const content = container instanceof globalThis.Element ? container.firstElementChild : null;
      if (container === null || !(content instanceof globalThis.Element)) return false;
      return Math.abs(content.getBoundingClientRect().width - container.clientWidth) <= 1;
    },
    { timeout: 10_000 },
  );
}

/** 折叠线回归(第 4 轮修复):滚动在顶时,每张节点卡必须完整落在画布容器的可视
 * 矩形内——底边越线即「画布比容器高,底部节点被裁」。 */
async function assertNodesInsideCanvas(page) {
  const clip = await page.evaluate(() => {
    const container = globalThis.document.querySelector('[data-testid="collaboration-topology"]');
    if (!(container instanceof globalThis.Element)) return null;
    const box = container.getBoundingClientRect();
    return [...container.querySelectorAll('[data-testid^="collaboration-node-"]')].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        id: card.getAttribute("data-testid"),
        overBottom: rect.bottom - box.bottom,
        overTop: box.top - rect.top,
      };
    });
  });
  assert.ok(clip !== null && clip.length > 0, "the topology canvas and its node cards must be present");
  for (const node of clip)
    assert.ok(
      node.overBottom <= 0.5 && node.overTop <= 0.5,
      `node card ${node.id} must sit fully inside the visible canvas ` +
        `(overBottom=${node.overBottom.toFixed(1)}, overTop=${node.overTop.toFixed(1)})`,
    );
}

/** 抽屉滑入沉降:motion 的进出场动画只动 transform(x: 110% → 0);截图与视觉
 * 断言前必须等平移归零,否则拍下的是被窗口右缘裁切的半进面板(第 2 轮「右侧
 * 没有内边距」的截图实为动画末端)。等的是离散条件(矩阵 m41≈0),不是墙钟。 */
async function drawerSettled(page) {
  await page.waitForFunction(
    () => {
      const panel = globalThis.document.querySelector('[role="dialog"]');
      if (panel === null) return false;
      const transform = globalThis.getComputedStyle(panel).transform;
      if (transform === "none") return true;
      try {
        return Math.abs(new globalThis.DOMMatrixReadOnly(transform).m41) < 1;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  );
}

/** 抽屉适配回归(第 2 轮修复):标题与字段必须全部落在面板宽度内,不许横向溢出
 * (scrollWidth 是内容实际宽度,clientWidth 是面板可见宽度,差值>1 即有裁切)。 */
async function assertDrawerFits(page) {
  const overflow = await page.evaluate(() => {
    const panel = globalThis.document.querySelector('[role="dialog"]');
    if (panel === null) return null;
    return {
      scroll: panel.scrollWidth,
      client: panel.clientWidth,
      bodyScroll: Math.max(...[...panel.querySelectorAll("div,span,p,h2")].map((el) => el.scrollWidth), 0),
    };
  });
  assert.ok(overflow !== null, "the detail drawer must be open when checking fit");
  assert.ok(
    overflow.scroll <= overflow.client + 1,
    `drawer panel overflows horizontally: scrollWidth=${overflow.scroll} > clientWidth=${overflow.client}`,
  );
  assert.ok(
    overflow.bodyScroll <= overflow.client + 1,
    `drawer content overflows horizontally: widest child scrollWidth=${overflow.bodyScroll} > clientWidth=${overflow.client}`,
  );
}
