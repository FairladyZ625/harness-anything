import assert from "node:assert/strict";
import { makeDecisionService } from "@harness-anything/application";
import { compileDecisionWrite, makeTaskEventStore, makeTaskProjection } from "@harness-anything/kernel";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

/**
 * 剩余功能面板(task_d87e6982658ceccc5f26c80f30)的真实交互旅程:
 * 工作列表/议程/看板/研发态势/失真预警/待办签发/任务·事实·决策·工作详情/实体/预设/
 * 引擎适配器/Agent·Squad/Token/系统/Daemon观察/设置/账号访问控制。
 * 验收不止「面板挂出真实功能体」:详情面板逐个做本地实体切换(两次选择、两次正文
 * 对照),工作面板经 daemon 单写队列真实创建两件工作;设置/账号面板在 360px 窄浮窗
 * 里量 scrollWidth,横向溢出当场红。断言只认 data-testid;等待一律 waitFor 的离散
 * 条件,不用墙钟 sleep。终端/浏览器的资源生命周期在 workbench-lifecycle-panels。
 */
const BODY = "[data-testid='floating-panel-body']";
const CATALOG_ENTRY = (id) => `[data-testid='panel-catalog-entry-${id}']`;

const PROBE_FACT_STATEMENT = "Workbench detail panels switch facts through the local picker.",
  PROBE_DECISION_ID = "dec_workbench_probe",
  PROBE_DECISION_TITLE = "Probe decision for the workbench detail picker",
  WORK_ALPHA = { taskId: "task-wb-probe-alpha", title: "Workbench probe work alpha" },
  WORK_BETA = { taskId: "task-wb-probe-beta", title: "Workbench probe work beta" };

/**
 * 夹具种子(lanes.mjs 的 beforeRestart 调用,triadic-ledger 之后):追加第二个
 * 提案决策,让决策详情面板的本地选择有第二个可切换的实体。共享的 seedTriadicEvents
 * 不动——service-bridge vitest 断言 facts.length === 1。第二个事实**不在这里种**:
 * 挂在 task-gui-smoke 上会改变它的事实邻域构成(panel-workspace 对此敏感),所以
 * 由场景在运行时经单写队列挂在探针工作上(见 recordProbeFact)。
 */
export async function seedWorkbenchDetailEntities(rootDir, repoId, writerFence) {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    decisionService = makeDecisionService({ eventStore: store, projection }),
    actor = { principal: { personId: "person-gui" }, executor: null };
  try {
    const revision = (store.readHead()?.revision ?? 0) + 1;
    void revision;
    const append = (type, payload) => {
      const decisionRevision = (store.readHead()?.revision ?? 0) + 1,
        event = {
          schema: "decision-event/v1",
          eventId: `event-wb-probe-${type}-${decisionRevision}`,
          workspaceRevision: decisionRevision,
          opId: `op-wb-probe-${type}-${decisionRevision}`,
          decisionId: PROBE_DECISION_ID,
          type,
          actor,
          source: "local",
          occurredAt: "2026-08-13T00:01:41.000Z",
          payload,
        },
        read = projection.readDecision(PROBE_DECISION_ID),
        document = projection.readDocument(`decisions/decision-${PROBE_DECISION_ID}/decision.md`).document,
        relations = projection
          .readDecisionGraph()
          .edges.filter((edge) => edge.ownerRef === `decision/${PROBE_DECISION_ID}`)
          .map((edge) => ({
            relation_id: edge.relationId,
            source: edge.sourceRef,
            target: edge.targetRef,
            type: edge.relationType,
            strength: edge.strength,
            direction: edge.direction,
            origin: edge.origin,
            rationale: edge.rationale,
            state: edge.state,
          }));
      decisionService.record(
        compileDecisionWrite({
          event,
          currentDecision: read.decision,
          currentRelations: relations,
          currentDocument: document,
        }),
      );
    };
    append("decision_proposed", {
      title: PROBE_DECISION_TITLE,
      question: "Fixture probe: does the decision detail panel switch entities locally?",
      riskTier: "low",
      urgency: "low",
      vertical: "software/coding",
      preset: "architecture-decision",
      appliesTo: { modules: ["gui"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Keep the probe as fixture data" }],
      rejected: [{ id: "RJ1", text: "Assert on the single seeded decision", whyNot: "It proves no switching" }],
      body: "\n# Probe decision for the workbench detail picker\n",
      claims: [],
      fulfillments: [],
      relations: [],
      provenance: [
        {
          runtime: "codex",
          sessionId: "wb-probe-decision",
          transcriptReachability: "by_session_id",
          boundAt: "2026-08-13T00:01:30.000Z",
        },
      ],
    });
  } finally {
    projection.close();
    await store.drain();
  }
}

/** `ha work create` 的同一条单写路:经 daemon RPC 建 declared work(taskClass=work)。 */
async function createProbeWork(fixture, { taskId, title }) {
  const created = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.task.create",
    {
      repo: { repoId: fixture.repoId },
      payload: { taskId, title, taskClass: "work", presetId: "create-work" },
    },
    2_000,
    30_000,
  );
  if (created.ok !== true) throw new Error(`probe work create failed: ${JSON.stringify(created)}`);
  return created;
}

/** `ha fact record` 的同一条单写路:探针事实挂在探针工作上(不占 task-gui-smoke
 * 的事实邻域——panel-workspace 对其构成敏感),经台账 cut 扇出进事实投影。 */
async function recordProbeFact(fixture, taskId) {
  const recorded = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.task.run",
    {
      repo: { repoId: fixture.repoId },
      payload: {
        action: {
          kind: "fact-record",
          taskId,
          statement: PROBE_FACT_STATEMENT,
          evidenceSource: "GUI workbench e2e",
          confidence: "medium",
          memoryClass: "episodic",
        },
      },
    },
    2_000,
    30_000,
  );
  if (recorded.ok !== true) throw new Error(`probe fact record failed: ${JSON.stringify(recorded)}`);
  return recorded;
}

async function ensureCatalogOpen(page) {
  const open = await page.getByTestId("panel-catalog-list").isVisible();
  if (!open) await page.getByTestId("panel-catalog-button").click();
  await page.getByTestId("panel-catalog-list").waitFor();
}

async function addPanel(page, id) {
  await ensureCatalogOpen(page);
  await page.locator(CATALOG_ENTRY(id)).click();
}

async function waitForPanelBody(page, panelId, bodySelector) {
  await page.locator(`${BODY}[data-panel-id='${panelId}'] ${bodySelector}`).first().waitFor();
}

/** 面板众多时互相叠放:先点拖条把目标浮窗抬到顶层,后续点击不被邻居截走。 */
function panelWindow(page, panelId) {
  return page.locator(".dv-resize-container").filter({ has: page.locator(`${BODY}[data-panel-id='${panelId}']`) });
}

async function raisePanel(page, panelId) {
  await panelWindow(page, panelId).locator(".dv-floating-titlebar").click();
}

/** 选择后正文随动:等待面板内目标容器出现该文本(离散条件,不 sleep)。
 * 文本必须锚在正文容器上——下拉的 <option> 也含同样文本,且是隐藏元素。 */
async function waitForPanelBodyText(page, panelId, contentSelector, text) {
  await page
    .locator(`${BODY}[data-panel-id='${panelId}'] ${contentSelector}`)
    .getByText(text, { exact: true })
    .first()
    .waitFor();
}

/** 窄浮窗下的横向溢出检查:面板体 overflow-hidden,溢出内容被裁掉但 scrollWidth 仍暴露。 */
async function assertNoHorizontalOverflow(page, panelId) {
  const spill = await page
    .locator(`${BODY}[data-panel-id='${panelId}']`)
    .evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  assert.ok(
    spill.scroll <= spill.client + 1,
    `panel ${panelId} overflows its narrow body: scrollWidth ${spill.scroll} > clientWidth ${spill.client}`,
  );
  return spill;
}

/** 把浮窗右缘拖窄到目标宽(dockview 缩放手柄,真实拖拽路径)。 */
async function dragNarrow(page, panelId, targetWidth) {
  const host = panelWindow(page, panelId);
  await raisePanel(page, panelId);
  const box = await host.boundingBox();
  const handle = host.locator(".dv-resize-handle-right");
  const handleBox = await handle.boundingBox();
  const startX = handleBox.x + handleBox.width / 2,
    startY = handleBox.y + handleBox.height / 2,
    delta = box.width - targetWidth;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(startX - (delta * step) / 10, startY);
  }
  await page.mouse.up();
}

export default {
  id: "workbench-remaining-panels",
  feature: "panel-workspace",
  lane: "isolated",
  description:
    "The workbench mounts the remaining real-route panels and exercises real behavior: detail panels switch entities through their local pickers (task/fact/decision/work), works are created through the daemon single-write queue, and settings/identity panels hold a 360px narrow body without horizontal overflow.",
  async run({ page, fixture, shot }) {
    await bridgeReady(page);
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await page.locator("[data-testid='floating-panel-grid']").waitFor();
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const ids = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return ids.length === 3 && ["documents", "graph", "timeline"].every((id) => ids.includes(id));
    });

    // 台账域:工作列表(开始一项工作主动作在面板动作条)、议程(筛选行)、看板(筛选条)。
    await addPanel(page, "works");
    await waitForPanelBody(page, "works", "[data-testid='work-view']");
    await waitForPanelBody(page, "works", "[data-testid='work-start-work']");
    await addPanel(page, "agenda");
    await waitForPanelBody(page, "agenda", "[data-testid='agenda-view']");
    await waitForPanelBody(page, "agenda", "[data-testid='agenda-filter-chips']");
    await addPanel(page, "board");
    await waitForPanelBody(page, "board", "[data-testid='board-filter-bar']");
    // 看板面板:卡片点击开面板本地预览抽屉;抽屉壳 portal 到 body,不在浮窗容器里。
    const boardCard = page.locator(`${BODY}[data-panel-id='board'] [data-testid='board-task-card']`).first();
    await raisePanel(page, "board");
    await boardCard.waitFor();
    await boardCard.click();
    const drawer = page.locator("body > aside[role='dialog']");
    await drawer.waitFor();
    const drawerInPanel = await page.locator(`${BODY}[data-panel-id='board'] aside[role='dialog']`).count();
    assert.equal(drawerInPanel, 0, "preview drawer portals out of the floating panel");
    await shot("workbench-board-local-preview");
    await page.keyboard.press("Escape");

    // 工作详情面板:经 daemon 单写队列真实创建两件工作,下拉在两件之间切换,
    // 范围正文(workspace 根标题)随动;选择归面板,全局路由不动(仍在工作台)。
    await addPanel(page, "workDetail");
    await waitForPanelBody(page, "workDetail", "[data-testid='workbench-work-detail-root']");
    await createProbeWork(fixture, WORK_ALPHA);
    await createProbeWork(fixture, WORK_BETA);
    await recordProbeFact(fixture, WORK_BETA.taskId);
    const workPicker = page.getByTestId("workbench-work-detail-root");
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll("[data-testid='workbench-work-detail-root'] option").length >= 3,
    );
    await workPicker.selectOption(WORK_ALPHA.taskId);
    await waitForPanelBodyText(page, "workDetail", "[data-testid='workspace-view'] h1", WORK_ALPHA.title);
    await workPicker.selectOption(WORK_BETA.taskId);
    await waitForPanelBodyText(page, "workDetail", "[data-testid='workspace-view'] h1", WORK_BETA.title);
    assert.ok(
      await page.locator("[data-testid='floating-panel-grid']").isVisible(),
      "panel-local work selection must not leave the workbench route",
    );
    await shot("workbench-work-detail-switch");

    // 治理域:待办签发总池(域 Tab)、四个详情面板的本地实体切换。
    await addPanel(page, "decisionPool");
    await waitForPanelBody(page, "decisionPool", "[data-testid='attestation-pool-view']");

    // 任务详情:task-gui-smoke ↔ 探针工作两向切换,标题行随动。
    await addPanel(page, "taskDetail");
    await waitForPanelBody(page, "taskDetail", "[data-testid='task-detail-view']");
    const taskPicker = page.getByTestId("workbench-task-detail-task");
    await taskPicker.selectOption("task-gui-smoke");
    await waitForPanelBodyText(page, "taskDetail", "h1", "Render the real triadic projection");
    await taskPicker.selectOption(WORK_BETA.taskId);
    await waitForPanelBodyText(page, "taskDetail", "h1", WORK_BETA.title);
    await taskPicker.selectOption("task-gui-smoke");
    await waitForPanelBodyText(page, "taskDetail", "h1", "Render the real triadic projection");

    // 事实详情:种子事实 ↔ 探针事实两向切换,结论区(statement)随动。
    await addPanel(page, "factDetail");
    await waitForPanelBody(page, "factDetail", "[data-testid='workbench-fact-detail-fact']");
    const factPicker = page.getByTestId("workbench-fact-detail-fact");
    await factPicker.selectOption({ label: "The GUI renderer received event-backed triadic rows." });
    await waitForPanelBodyText(
      page,
      "factDetail",
      "[data-testid='fact-conclusion']",
      "The GUI renderer received event-backed triadic rows.",
    );
    await factPicker.selectOption({ label: PROBE_FACT_STATEMENT });
    await waitForPanelBodyText(page, "factDetail", "[data-testid='fact-conclusion']", PROBE_FACT_STATEMENT);

    // 决策详情:种子决策 ↔ 探针决策两向切换,详情头标题随动。
    await addPanel(page, "decisionDetail");
    await waitForPanelBody(page, "decisionDetail", "[data-testid='workbench-decision-detail-decision']");
    const decisionPicker = page.getByTestId("workbench-decision-detail-decision");
    await decisionPicker.selectOption("dec_gui_smoke");
    await waitForPanelBodyText(
      page,
      "decisionDetail",
      "[data-testid='decision-detail-header'] h1",
      "Expose the triadic projection to the GUI",
    );
    await decisionPicker.selectOption(PROBE_DECISION_ID);
    await waitForPanelBodyText(
      page,
      "decisionDetail",
      "[data-testid='decision-detail-header'] h1",
      PROBE_DECISION_TITLE,
    );
    await decisionPicker.selectOption("dec_gui_smoke");
    await waitForPanelBodyText(
      page,
      "decisionDetail",
      "[data-testid='decision-detail-header'] h1",
      "Expose the triadic projection to the GUI",
    );
    await shot("workbench-detail-pickers");

    await addPanel(page, "cadence");
    // cadence 的模式/扫描计数在被卸下的页头里;面板内以真实区域板为钩子。
    await waitForPanelBody(page, "cadence", "[data-testid='cadence-board'], [data-testid='cadence-unavailable']");
    await addPanel(page, "freshness");
    await waitForPanelBody(page, "freshness", "[data-testid='freshness-view']");

    // 系统域:预设/适配器/实体/Agent·Squad/Token/系统/Daemon观察。
    for (const [id, body] of [
      ["presets", "[data-testid='presets-content'], [data-testid^='preset']"],
      ["adapters", "[data-testid='adapters-content'], [data-testid='workbench-adapters-panel'] p"],
      ["entities", "[data-testid='entities-view'], section"],
      ["agentSquad", "[data-testid='agent-squad-view']"],
      ["tokenUsage", "[data-testid='token-usage-view']"],
      ["system", "[data-testid='system-conclusion']"],
      ["daemonObserve", "[data-testid='daemon-observe-content']"],
    ]) {
      await addPanel(page, id);
      await waitForPanelBody(page, id, body);
    }
    await shot("workbench-system-domain-panels");

    // 设置/账号访问控制:identityAccess 只认真实视图(Electron 桌面桥在位),
    // 任何 alert 兜底都不算数。两块分别「添加即顶层」时拖到 ~360px 窄宽:
    // 面板体不得横向溢出(overflow-hidden 下溢出内容被裁掉,scrollWidth 仍会暴露)。
    // 真实拖拽缩放路径,不是改 CSS 变量。
    for (const [id, body] of [
      ["settings", "[data-testid='settings-content']"],
      ["identityAccess", "[data-testid='identity-access-view']"],
    ]) {
      await addPanel(page, id);
      await waitForPanelBody(page, id, body);
      await page.keyboard.press("Escape");
      await dragNarrow(page, id, 340);
      const spill = await assertNoHorizontalOverflow(page, id);
      assert.ok(spill.client <= 420, `panel ${id} should actually be narrow (clientWidth ${spill.client})`);
      await shot(`workbench-${id}-narrow`);
    }

    // 收尾:重置回默认三块。详情面板的面包屑里有「面板工作台」同名按钮,
    // 不收尾会让后续场景的导航定位违反 strict mode(panel-workbench-catalog 同一收尾)。
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const ids = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return ids.length === 3 && ["documents", "graph", "timeline"].every((id) => ids.includes(id));
    });
  },
};
