// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { CollaborationView } from "../src/renderer/views/CollaborationView.tsx";
import type { FleetOverviewRead } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

/** daemon `repo.fleet.overview.read` 的最小真实形状夹具:三态字段齐全,只改需要的块。 */
function overview(overrides: Partial<FleetOverviewRead> = {}): FleetOverviewRead {
  return {
    schema: "daemon.fleet-overview/v1",
    ok: true,
    repoId: "repo-test",
    mode: "remote-center",
    generatedAt: "2026-10-06T00:00:00.000Z",
    center: {
      nodeId: "center",
      daemonId: "default",
      startedAt: "2026-10-01T00:00:00.000Z",
      version: "0.0.0",
      commitSha: "bd2251a",
    },
    centerRevision: 164,
    nodes: [
      {
        nodeId: "center",
        role: "center",
        owner: { kind: "value", text: "daemon" },
        build: { kind: "value", text: "0.0.0 @ bd2251a" },
        online: { kind: "value", text: "running" },
        leases: [
          {
            taskId: "task_local1",
            title: "本机租约任务",
            coordinationStatus: "active",
            phase: "held",
            expiresAt: "2026-10-07T00:00:00.000Z",
            principal: { personId: "person_zeyu" },
            runtimeSessionId: "runtime_center_session",
            dispatchId: "dispatch_center",
            agentId: "agent_ceo",
            agentLabel: "CEO",
            startedAt: "2026-10-06T00:10:00.000Z",
            dispatchStatus: "running",
          },
        ],
        replica: null,
        replicaNote: null,
        watch: { kind: "value", text: "local canonical writer" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
      {
        nodeId: "cc90-ubuntu",
        role: "edge",
        owner: { kind: "value", text: "person_zeyu" },
        build: { kind: "unavailable", reason: "replica-status-has-no-build-field" },
        online: { kind: "unavailable", reason: "tls-session-fact-not-exposed" },
        leases: [
          {
            taskId: "task_edge1",
            title: "边缘租约任务",
            coordinationStatus: "active",
            phase: "held",
            expiresAt: "2026-10-07T00:00:00.000Z",
            principal: { personId: "person_zeyu" },
            runtimeSessionId: "runtime_edge_session",
            dispatchId: "dispatch_edge",
            agentId: "agent_worker",
            agentLabel: "Worker",
            startedAt: "2026-10-06T00:20:00.000Z",
            dispatchStatus: "running",
          },
        ],
        replica: {
          repoId: "repo-test",
          viewId: "view-ubuntu",
          centerRevision: 164,
          centerEventAt: "2026-10-06T00:30:00.000Z",
          ackRevision: 163,
          ackedAt: "2026-10-06T00:29:00.000Z",
          lagRevisions: 1,
          lagMs: 61_000,
          delivery: "delta",
        },
        replicaNote: null,
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
    ],
    links: [
      {
        nodeId: "cc90-ubuntu",
        state: "lag",
        delivery: "delta",
        lagRevisions: 1,
        lagMs: 61_000,
        ackedAt: "2026-10-06T00:29:00.000Z",
        centerRevision: 164,
      },
    ],
    events: [
      {
        eventId: "row-1",
        type: "task_status_changed",
        occurredAt: "2026-10-06T00:28:00.000Z",
        workspaceRevision: 163,
        taskId: "task_edge1",
        title: "边缘任务状态变化",
        nodeId: "cc90-ubuntu",
      },
      {
        eventId: "row-2",
        type: "fact_recorded",
        occurredAt: "2026-10-06T00:25:00.000Z",
        workspaceRevision: 160,
        taskId: null,
        title: "中心事实",
        nodeId: "center",
      },
    ],
    notes: ["events-attribution=current-lease", "edge-online=unavailable", "sync-internals=unavailable"],
    warnings: [],
    ...overrides,
  };
}

describe("舰队拓扑视觉重做(task_16c20131)", () => {
  it("连线层按通道状态着状态:lag 有流光,unsynced 无流光,无副本行的节点是 absent 虚线", () => {
    const data = overview();
    data.nodes = [
      ...data.nodes,
      {
        ...data.nodes[1]!,
        nodeId: "edge-unsynced",
        leases: [],
        replica: null,
        replicaNote: "center-replica-ledger-has-no-row-for-node",
      },
    ];
    data.links = [
      ...data.links,
      {
        nodeId: "edge-unsynced",
        state: "unsynced",
        delivery: "degraded",
        lagRevisions: null,
        lagMs: null,
        ackedAt: null,
        centerRevision: 164,
      },
    ];
    const view = renderView({ data });
    const lagLink = view.host.querySelector('g.fleet-link[data-node="cc90-ubuntu"]');
    expect(lagLink!.getAttribute("data-state")).toBe("lag");
    expect(lagLink!.querySelector(".fleet-link-flow")).not.toBeNull();
    const unsyncedLink = view.host.querySelector('g.fleet-link[data-node="edge-unsynced"]');
    expect(unsyncedLink!.getAttribute("data-state")).toBe("unsynced");
    expect(unsyncedLink!.querySelector(".fleet-link-flow")).toBeNull();
    // 无副本行(ghost)没有 daemon link:连线层按 absent 给灰虚线,节点卡同步标注。
    const ghost = {
      ...data.nodes[1]!,
      nodeId: "ghost-node",
      leases: [],
      replica: null,
      replicaNote: "center-replica-ledger-has-no-row-for-node",
    };
    const withGhost = overview();
    withGhost.nodes = [...withGhost.nodes, ghost];
    const ghostView = renderView({ data: withGhost });
    expect(ghostView.host.querySelector('g.fleet-link[data-node="ghost-node"]')!.getAttribute("data-state")).toBe(
      "absent",
    );
    expect(
      ghostView.host.querySelector('[data-testid="collaboration-node-ghost-node"]')!.getAttribute("data-state"),
    ).toBe("absent");
  });

  it("详情是右侧滑入抽屉(role=dialog),cut 细进度条与 lag 小柱带 aria 值", () => {
    const view = renderView();
    expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    view.click(view.nodeCard("cc90-ubuntu"));
    const dialog = view.host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const cut = view.host.querySelector<HTMLElement>('[data-testid="collaboration-cut-progress"]')!;
    expect(cut.getAttribute("aria-valuenow")).toBe("163");
    expect(cut.getAttribute("aria-valuemax")).toBe("164");
    const lag = view.host.querySelector<HTMLElement>('[data-testid="collaboration-lag-bar"]')!;
    expect(lag.getAttribute("aria-valuenow")).toBe("1");
    view.click(view.host.querySelector('[data-testid="collaboration-node-details-close"]'));
    // 关闭是选择态清空(aria-pressed 归 false);面板卸载走 Drawer 的退出动画,
    // 其卸载契约由 Drawer 原语自己的测试覆盖,这里不断言退出中的 DOM。
    expect(view.nodeCard("cc90-ubuntu")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("再次点击已选中的节点收起抽屉(aria-pressed 开关语义)", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    expect(view.host.querySelector('[role="dialog"]')).not.toBeNull();
    view.click(view.nodeCard("cc90-ubuntu"));
    expect(view.nodeCard("cc90-ubuntu")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("第 2 轮视觉修正:四态连线图例、中心能量核心与节点状态点在画布上", () => {
    const view = renderView();
    const legend = view.host.querySelector('[data-testid="collaboration-link-legend"]')!;
    expect(legend).not.toBeNull();
    expect(legend.textContent).toContain("已同步");
    expect(legend.textContent).toContain("灰虚线＝从未同步");
    // 四态各一枚色样(fresh/lag/unsynced/absent),线型本身即图例。
    expect(legend.querySelectorAll(".fleet-legend")).toHaveLength(4);
    expect(legend.querySelector(".fleet-legend--absent .fleet-legend-key")).not.toBeNull();
    // 中心能量核心:径向光晕 + 细环(SVG 组),不依赖 JS 运行时。
    expect(view.host.querySelector('[data-testid="collaboration-core"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="collaboration-core"] .fleet-core-ring')).not.toBeNull();
    // 节点卡状态点:与连线同色的扫视锚点。
    expect(view.nodeCard("cc90-ubuntu")!.querySelector(".fleet-state-dot")).not.toBeNull();
  });

  it("第 3 轮:中心卡是能量核心读数板(rev/边缘/在飞 + head 短 hash)", () => {
    const view = renderView();
    const card = view.nodeCard("center")!;
    const metrics = card.querySelector('[data-testid="collaboration-core-metrics"]')!;
    expect(metrics.textContent).toContain("rev 164");
    expect(metrics.textContent).toContain("边缘 1");
    // 在飞数按整个舰队计:夹具里中心 1 + 边缘 1 两笔 held 租约。
    expect(metrics.textContent).toContain("在飞 2");
    const head = card.querySelector('[data-testid="collaboration-core-head"]')!;
    expect(head.textContent).toContain("head bd2251a");
    expect(head.getAttribute("title")).toContain("bd2251a");
    // 第 4 轮:标题旁不再渲染裸 daemonId——无标签短 id(夹具外场如 "g")读作孤立
    // 碎片;daemon 身份由详情抽屉带标签完整展示(daemonId · version @ sha)。
    expect(card.textContent).not.toContain("default");
    // 边缘卡保持原读数(owner + cut),不被中心卡的布局改写。
    expect(view.nodeCard("cc90-ubuntu")!.textContent).toContain("cut 163/164");
  });

  it("第 3 轮:fresh/lag 连线携带粒子列车层,absent/unsynced 不携带", () => {
    const view = renderView();
    expect(view.host.querySelectorAll(".fleet-link-particles")).toHaveLength(1);
    expect(view.host.querySelector('g.fleet-link[data-state="lag"] .fleet-link-particles')).not.toBeNull();
  });

  it("执行中的节点带执行标记,事件行带进入动效类", () => {
    const view = renderView();
    expect(view.nodeCard("cc90-ubuntu")!.getAttribute("data-executing")).toBe("on");
    expect(view.nodeCard("center")!.getAttribute("data-executing")).toBe("on");
    const idle = overview();
    idle.nodes = idle.nodes.map((node) => (node.nodeId === "cc90-ubuntu" ? { ...node, leases: [] } : node));
    const idleView = renderView({ data: idle });
    expect(idleView.nodeCard("cc90-ubuntu")!.getAttribute("data-executing")).toBeNull();
    const row = view.host.querySelector('[data-testid="collaboration-event-evt-row-1"]');
    expect(row!.className).toContain("fleet-event-in");
  });

  it("读面刷新出现新事件时,其所属节点在拓扑上闪一下", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const first = overview();
    act(() =>
      root.render(
        <CollaborationView
          repoId="repo-test"
          mode="remote-center"
          overview={first}
          onOpenTask={() => {}}
          onNavigateEntity={() => {}}
          now="2026-10-06T01:00:00.000Z"
        />,
      ),
    );
    expect(host.querySelector('[data-testid="collaboration-node-cc90-ubuntu"]')!.getAttribute("data-flash")).toBeNull();
    const refreshed = overview();
    refreshed.events = [
      ...refreshed.events,
      {
        eventId: "row-3",
        type: "fact_recorded",
        occurredAt: "2026-10-06T00:31:00.000Z",
        workspaceRevision: 164,
        taskId: null,
        title: null,
        nodeId: "cc90-ubuntu",
      },
    ];
    act(() =>
      root.render(
        <CollaborationView
          repoId="repo-test"
          mode="remote-center"
          overview={refreshed}
          onOpenTask={() => {}}
          onNavigateEntity={() => {}}
          now="2026-10-06T01:00:00.000Z"
        />,
      ),
    );
    expect(host.querySelector('[data-testid="collaboration-node-cc90-ubuntu"]')!.getAttribute("data-flash")).toBe("on");
    expect(host.querySelector('[data-testid="collaboration-node-center"]')!.getAttribute("data-flash")).toBeNull();
  });
});

function renderView(
  overrides: {
    data?: FleetOverviewRead | null;
    mode?: "local" | "remote-center";
    error?: string | null;
    loading?: boolean;
  } = {},
) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const openedTasks: string[] = [];
  const navigatedRefs: string[] = [];
  act(() =>
    root.render(
      <CollaborationView
        repoId="repo-test"
        mode={overrides.mode ?? "remote-center"}
        overview={overrides.data === undefined ? overview() : overrides.data}
        overviewError={overrides.error ?? null}
        overviewLoading={overrides.loading ?? false}
        now="2026-10-06T01:00:00.000Z"
        onOpenTask={(id) => openedTasks.push(id)}
        onNavigateEntity={(ref) => navigatedRefs.push(ref)}
      />,
    ),
  );
  return {
    host,
    root,
    openedTasks,
    navigatedRefs,
    text: () => host.textContent ?? "",
    nodeCard: (nodeId: string) => host.querySelector<HTMLElement>(`[data-testid="collaboration-node-${nodeId}"]`),
    click: (element: Element | null | undefined) => {
      expect(element, "click target must exist").not.toBeNull();
      act(() => element!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    },
  };
}

describe("协作页舰队拓扑契约", () => {
  it("拓扑渲染 daemon 给出的中心与边缘节点,不自行推断节点集合", () => {
    const view = renderView();
    expect(view.nodeCard("center")).not.toBeNull();
    expect(view.nodeCard("cc90-ubuntu")).not.toBeNull();
    expect(view.nodeCard("edge-mac")).toBeNull();
    expect(view.nodeCard("cc90-ubuntu")!.getAttribute("aria-pressed")).toBe("false");
    expect(view.text()).toContain("2 节点");
    expect(view.text()).toContain("2 事件");
  });

  it("本地仓显示中心提示条;读失败显示失败横幅而非空拓扑", () => {
    const local = renderView({ mode: "local" });
    expect(local.host.querySelector('[data-testid="collaboration-center-notice"]')).not.toBeNull();
    const failed = renderView({ error: "repo_unavailable" });
    expect(failed.host.querySelector('[data-testid="collaboration-read-error"]')!.textContent).toContain(
      "repo_unavailable",
    );
  });

  it("授权类读拒绝显示人话原因,机器码只进 data-reason/title;未识别码原样保留", () => {
    const denied = renderView({ error: "authorization_denied" });
    const banner = denied.host.querySelector<HTMLElement>('[data-testid="collaboration-read-error"]')!;
    expect(banner.textContent).toContain("当前身份未获授权查看舰队拓扑");
    expect(banner.textContent).not.toContain("authorization_denied");
    expect(banner.getAttribute("data-reason")).toBe("authorization_denied");
    expect(banner.getAttribute("title")).toBe("authorization_denied");
    const unknown = renderView({ error: "fleet_edge_config_invalid" });
    const raw = unknown.host.querySelector<HTMLElement>('[data-testid="collaboration-read-error"]')!;
    expect(raw.textContent).toContain("fleet_edge_config_invalid");
    expect(raw.getAttribute("data-reason")).toBeNull();
  });

  it("加载且无数据时显示读取态,不给空舰队", () => {
    const view = renderView({ data: null, loading: true });
    expect(view.text()).toContain("正在读取舰队拓扑");
    expect(view.host.querySelector('[data-testid="collaboration-topology"]')).toBeNull();
  });

  it("点击节点打开详情:在做什么显示租约任务/Agent/会话,内部状态显示副本 cut/lag", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    const details = view.host.querySelector('[data-testid="collaboration-node-details"]')!;
    expect(details).not.toBeNull();
    expect(details.textContent).toContain("边缘租约任务");
    expect(details.textContent).toContain("Worker");
    // 会话标识在跳转链接的 title 里(可见标签是 session),不在文本流里。
    expect(details.outerHTML).toContain("runtime_edge_session");
    expect(details.textContent).toContain("163 / 164");
    expect(details.textContent).toContain("delta");
    view.click(view.nodeCard("center"));
    const centerDetails = view.host.querySelector('[data-testid="collaboration-node-details"]')!;
    expect(centerDetails.textContent).toContain("本机租约任务");
    expect(centerDetails.textContent).toContain("bd2251a");
    expect(view.openedTasks).toEqual([]);
  });

  it("详情里的任务点击走 onOpenTask,事件行点击跳到对应节点详情", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    view.click(view.host.querySelector('[data-testid="collaboration-task-task_edge1"]'));
    expect(view.openedTasks).toEqual(["task_edge1"]);
    view.click(view.host.querySelector('[data-testid="collaboration-event-evt-row-1"]'));
    expect(view.nodeCard("cc90-ubuntu")!.getAttribute("aria-pressed")).toBe("true");
    expect(view.host.querySelector('[data-testid="collaboration-node-details"]')!.textContent).toContain(
      "边缘租约任务",
    );
  });

  it("未提供字段显示「未提供」与人话原因,机器码只进 data-reason/title", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    const details = view.host.querySelector('[data-testid="collaboration-node-details"]')!;
    expect(details.textContent).toContain("未提供");
    // 人话原因:为什么没有、何时会有。
    expect(details.textContent).toContain("中心未在此读面暴露节点 TLS 会话事实");
    expect(details.textContent).toContain("watch/pull 内部状态在边缘节点本地");
    expect(details.textContent).toContain("生命周期读面尚无该节点的同步失败记录");
    // 机器码不进可见文本,只保留在 data-reason/title 属性供测试断言。
    expect(details.textContent).not.toContain("tls-session-fact-not-exposed");
    expect(details.textContent).not.toContain("edge-sync-internals-not-exposed");
    const online = details.querySelector('[data-reason="tls-session-fact-not-exposed"]');
    expect(online).not.toBeNull();
    expect(online!.getAttribute("title")).toBe("tls-session-fact-not-exposed");
  });

  it("副本账本无行的节点给出人话原因,owner 未登记显示人话标记", () => {
    const data = overview();
    const ghost = {
      ...data.nodes[1]!,
      nodeId: "ghost-node",
      owner: { kind: "value", text: "not-in-registry" },
      leases: [],
      replica: null,
      replicaNote: "center-replica-ledger-has-no-row-for-node",
    };
    data.nodes = [...data.nodes, ghost];
    const view = renderView({ data });
    view.click(view.nodeCard("ghost-node"));
    const details = view.host.querySelector('[data-testid="collaboration-node-details"]')!;
    expect(details.textContent).toContain("该节点从未在本中心同步过");
    expect(details.textContent).not.toContain("center-replica-ledger-has-no-row-for-node");
    expect(details.querySelector('[data-reason="center-replica-ledger-has-no-row-for-node"]')).not.toBeNull();
    expect(details.textContent).toContain("未登记负责人");
    expect(details.textContent).not.toContain("not-in-registry");
    // 节点卡上的 owner 同样人话化。
    expect(view.nodeCard("ghost-node")!.textContent).toContain("未登记负责人");
  });

  it("租约被权限裁剪时显示「无权限查看」与人话原因,不显示空租约列表", () => {
    const data = overview();
    data.nodes = data.nodes.map((node) =>
      node.nodeId === "cc90-ubuntu" ? { ...node, leases: { redacted: "insufficient_scope" } } : node,
    );
    const view = renderView({ data });
    view.click(view.nodeCard("cc90-ubuntu"));
    const redacted = view.host.querySelector('[data-testid="collaboration-node-leases-redacted"]')!;
    expect(redacted.textContent).toContain("无权限查看");
    expect(redacted.textContent).toContain("当前身份的权限范围不足以查看租约明细");
    expect(redacted.textContent).not.toContain("insufficient_scope");
    expect(redacted.getAttribute("data-reason")).toBe("insufficient_scope");
  });

  it("事件流可按节点过滤,过滤后只留该节点的事件", () => {
    const view = renderView();
    const filter = view.host.querySelector<HTMLSelectElement>('[data-testid="collaboration-event-filter"]')!;
    expect(view.host.querySelectorAll('[data-testid^="collaboration-event-evt"]').length).toBe(2);
    act(() => {
      filter.value = "cc90-ubuntu";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const rows = view.host.querySelectorAll('[data-testid^="collaboration-event-evt"]');
    expect(rows.length).toBe(1);
    expect(rows[0]!.getAttribute("data-testid")).toBe("collaboration-event-evt-row-1");
    expect(view.host.querySelector('[data-testid="collaboration-event-node-row-1"]')!.textContent).toContain(
      "cc90-ubuntu",
    );
  });

  it("读面限制声明(notes)渲染为人话图例,机器码串不再原样露出", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    const notes = view.host.querySelector('[data-testid="collaboration-read-notes"]')!;
    expect(notes.textContent).toContain("事件按任务当前租约归属节点");
    expect(notes.textContent).toContain("在线状态依赖中心 TLS 会话事实");
    expect(notes.textContent).not.toContain("events-attribution=");
    expect(notes.textContent).not.toContain("edge-online=");
    // 原始声明串保留在 title 供诊断与测试断言。
    expect(notes.querySelector('[title="events-attribution=current-lease"]')).not.toBeNull();
  });

  it("warnings 的人话文案可见,机器串只进 title;未识别的声明原样保留", () => {
    const warned = renderView({
      data: overview({
        warnings: ["node-owner-registry-unavailable: keycloak-unreachable", "future-unknown-warning"],
      }),
    });
    const warnings = warned.host.querySelector('[data-testid="collaboration-warnings"]')!;
    expect(warnings.textContent).toContain("节点负责人登记服务查询失败");
    expect(warnings.textContent).not.toContain("node-owner-registry-unavailable");
    expect(warnings.textContent).toContain("future-unknown-warning");
    const mapped = warnings.querySelector('[title="node-owner-registry-unavailable: keycloak-unreachable"]');
    expect(mapped).not.toBeNull();
    expect(mapped!.getAttribute("title")).toContain("keycloak-unreachable");
  });
});
