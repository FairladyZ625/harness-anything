// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { CollaborationView } from "../src/renderer/views/CollaborationView.tsx";
import type { CollaborationTask } from "../src/renderer/model/collaboration.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

function task(taskId: string, fields: Partial<CollaborationTask> = {}): CollaborationTask {
  return {
    taskId,
    title: `标题 ${taskId}`,
    lastKnownAt: "2026-10-01T00:00:00.000Z",
    coordinationStatus: "active",
    board: { columnId: "open", rank: 3 },
    ...fields,
  };
}

const HELD_LEASE = {
  leaseActor: {
    principal: { personId: "person_zeyu" },
    executor: { kind: "agent" as const, id: "runtime-session:runtime_a520047968e6" },
  },
  leaseSource: { kind: "node" as const, nodeId: "edge-mac" },
  leasePhase: "held",
  leaseExpiresAt: "2026-10-05T00:00:00.000Z",
};

function renderView(
  overrides: { tasks?: readonly CollaborationTask[]; mode?: "local" | "remote-center"; ready?: boolean } = {},
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
        tasks={overrides.tasks ?? []}
        ready={overrides.ready ?? true}
        now="2026-10-01T12:00:00.000Z"
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
    rows: () => [...host.querySelectorAll('[data-testid="collaboration-row"]')],
  };
}

describe("协作页内容契约", () => {
  it("每行同时给资格侧与执行侧:指派对象、执行人/会话、节点、phase", () => {
    const view = renderView({
      tasks: [
        task("task-held", {
          assignment: { assignee: { kind: "person", personId: "person_ana" }, expiresAt: "2026-10-02T00:00:00.000Z" },
          ...HELD_LEASE,
        }),
      ],
    });
    const row = view.rows()[0]!;
    expect(row.getAttribute("data-task-id")).toBe("task-held");
    expect(row.textContent).toContain("person_ana");
    expect(row.textContent).toContain("zeyu"); // principal personId 的可读名(完整串在悬停)
    expect(row.textContent).toContain("edge-mac");
    expect(row.textContent).toContain("执行中"); // lease phase=held
    // executor 是 runtime-session 时给会话跳转,链接文本是 session/<id>
    const sessionLink = row.querySelector<HTMLButtonElement>('button[title*="runtime_a520047968e6"]');
    expect(sessionLink).not.toBeNull();
    act(() => sessionLink!.click());
    expect(view.navigatedRefs).toEqual(["session/runtime_a520047968e6"]);
    // 点标题打开任务详情
    act(() => row.querySelector<HTMLButtonElement>('[data-testid="collaboration-task-task-held"]')!.click());
    expect(view.openedTasks).toEqual(["task-held"]);
    act(() => view.root.unmount());
  });

  it("未指派如实显示且不构成可抢语义", () => {
    const view = renderView({ tasks: [task("task-bare", HELD_LEASE)] });
    const row = view.rows()[0]!;
    expect(row.textContent).toContain("未指派（不等于任何人可开工）");
    act(() => view.root.unmount());
  });

  it("指派过期但 lease 仍 held:资格侧标过期,执行侧仍是执行中,不显示可抢", () => {
    const view = renderView({
      tasks: [
        task("task-expired", {
          assignment: { assignee: { kind: "person", personId: "person_ana" }, expiresAt: "2026-09-30T00:00:00.000Z" },
          ...HELD_LEASE,
        }),
      ],
    });
    const row = view.rows()[0]!;
    expect(row.textContent).toContain("指派期限已过");
    expect(row.textContent).toContain("执行中");
    expect(row.textContent).not.toContain("可抢");
    expect(row.textContent).not.toContain("可领取");
    act(() => view.root.unmount());
  });

  it("无人持有租约的行显示执行侧空态", () => {
    const view = renderView({
      tasks: [
        task("task-idle", {
          assignment: { assignee: { kind: "team", teamId: "team-1" }, expiresAt: "2026-10-02T00:00:00.000Z" },
        }),
      ],
    });
    const row = view.rows()[0]!;
    expect(row.textContent).toContain("无人持有");
    expect(row.textContent).toContain("team-1");
    expect(row.textContent).toContain("工作组");
    act(() => view.root.unmount());
  });

  it("按人筛选只留命中行;维度叠加筛空给一键清除,清除后恢复", () => {
    const view = renderView({
      tasks: [
        task("task-ana", {
          assignment: { assignee: { kind: "person", personId: "person_ana" }, expiresAt: "2026-10-02T00:00:00.000Z" },
        }),
        task("task-bob", {
          assignment: { assignee: { kind: "person", personId: "person_bob" }, expiresAt: "2026-10-02T00:00:00.000Z" },
          leaseActor: {
            principal: { personId: "person_bob" },
            executor: { kind: "agent", id: "runtime-session:runtime_b1" },
          },
          leasePhase: "held",
        }),
      ],
    });
    expect(view.rows().map((row) => row.getAttribute("data-task-id"))).toEqual(["task-ana", "task-bob"]);
    const personChips = () => [
      ...view.host
        .querySelector('[data-testid="collaboration-filter-person"]')!
        .querySelectorAll<HTMLButtonElement>("button"),
    ];
    act(() =>
      personChips()
        .find((button) => button.textContent?.includes("ana"))!
        .click(),
    );
    expect(view.rows().map((row) => row.getAttribute("data-task-id"))).toEqual(["task-ana"]);
    // 人=ana 叠加 Agent=runtime_b1(bob 的会话)→ 交集为空:空态 + 清除入口
    const agentChip = view.host
      .querySelector('[data-testid="collaboration-filter-agent"] span[title="runtime-session:runtime_b1"]')
      ?.closest("button") as HTMLButtonElement;
    act(() => agentChip.click());
    expect(view.rows()).toEqual([]);
    expect(view.host.querySelector('[data-testid="collaboration-filter-empty"]')).not.toBeNull();
    act(() => view.host.querySelector<HTMLButtonElement>('[data-testid="collaboration-filter-clear"]')!.click());
    expect(view.rows().map((row) => row.getAttribute("data-task-id"))).toEqual(["task-ana", "task-bob"]);
    act(() => view.root.unmount());
  });

  it("节点汇总给出执行/被指派计数并明确在线状态未知", () => {
    const view = renderView({
      tasks: [
        task("task-1", {
          ...HELD_LEASE,
          assignment: {
            assignee: { kind: "person", personId: "person_ana", nodeId: "edge-a" },
            expiresAt: "2026-10-02T00:00:00.000Z",
          },
        }),
      ],
    });
    const nodes = view.host.querySelector('[data-testid="collaboration-nodes"]')!;
    expect(nodes.getAttribute("data-testid")).toBe("collaboration-nodes");
    expect(nodes.textContent).toContain("edge-mac");
    expect(nodes.textContent).toContain("edge-a");
    expect(nodes.textContent).toContain("在线状态未知");
    act(() => view.root.unmount());
  });

  it("纯本地落页给如实提示;远端中心不提示", () => {
    const local = renderView({ mode: "local", tasks: [task("task-1")] });
    expect(local.host.querySelector('[data-testid="collaboration-local-notice"]')).not.toBeNull();
    act(() => local.root.unmount());
    const center = renderView({ mode: "remote-center", tasks: [task("task-1")] });
    expect(center.host.querySelector('[data-testid="collaboration-local-notice"]')).toBeNull();
    act(() => center.root.unmount());
  });

  it("切面未读完与真空仓是两种状态", () => {
    const loading = renderView({ tasks: [], ready: false });
    expect(loading.text()).toContain("正在读取任务切面");
    act(() => loading.root.unmount());
    const empty = renderView({ tasks: [], ready: true });
    expect(empty.text()).toContain("本仓还没有任务");
    act(() => empty.root.unmount());
  });
});
