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
            personId: "person_zeyu",
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
            personId: "person_zeyu",
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
    notes: ["events-attribution=current-lease (canonical 事件按任务当前租约归属节点)"],
    warnings: [],
    ...overrides,
  };
}

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

  it("未提供字段显示「未提供」并保留原因,不编造值", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    const details = view.host.querySelector('[data-testid="collaboration-node-details"]')!;
    expect(details.textContent).toContain("未提供");
    expect(details.textContent).toContain("原因：tls-session-fact-not-exposed");
    expect(details.textContent).toContain("原因：edge-sync-internals-not-exposed");
  });

  it("租约被权限裁剪时显示「无权限查看」与原因,不显示空租约列表", () => {
    const data = overview();
    data.nodes = data.nodes.map((node) =>
      node.nodeId === "cc90-ubuntu" ? { ...node, leases: { redacted: "insufficient_scope" } } : node,
    );
    const view = renderView({ data });
    view.click(view.nodeCard("cc90-ubuntu"));
    const redacted = view.host.querySelector('[data-testid="collaboration-node-leases-redacted"]')!;
    expect(redacted.textContent).toContain("无权限查看");
    expect(redacted.textContent).toContain("insufficient_scope");
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

  it("daemon 的读面限制声明(warnings/notes)如实展示,不隐藏", () => {
    const view = renderView();
    view.click(view.nodeCard("cc90-ubuntu"));
    expect(view.text()).toContain("events-attribution=current-lease");
    const warned = renderView({
      data: overview({ warnings: ["node-owner-registry-unavailable: keycloak-unreachable"] }),
    });
    expect(warned.host.querySelector('[data-testid="collaboration-warnings"]')!.textContent).toContain(
      "keycloak-unreachable",
    );
  });
});
