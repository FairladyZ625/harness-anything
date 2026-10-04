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

/** FilterChips 的计数渲染在 chip 内的 <b> 里;取它做精确断言,不受标签文字干扰。 */
function chipCount(chip: HTMLButtonElement): string {
  return chip.querySelector("b")?.textContent ?? "";
}

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
    // 人=ana 叠加 会话=runtime_b1(bob 的会话)→ 交集为空:空态 + 清除入口
    const sessionChip = view.host
      .querySelector('[data-testid="collaboration-filter-session"] span[title="runtime-session:runtime_b1"]')
      ?.closest("button") as HTMLButtonElement;
    act(() => sessionChip.click());
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

describe("review be577 四个反例的修后视图行为", () => {
  it("页头「执行中」只计 held/reserving:orphaned 行内显示失联,不计入执行中", () => {
    const view = renderView({
      tasks: [
        task("task-held", HELD_LEASE),
        task("task-orphaned", {
          ...HELD_LEASE,
          leasePhase: "orphaned",
          leaseSource: { kind: "node" as const, nodeId: "edge-orphan" },
        }),
        task("task-bare", {}),
      ],
    });
    // 3 任务,只有 1 个 phase=held:页头不得把 orphaned 计成执行中
    expect(view.text()).toContain("3 任务 · 1 执行中");
    const orphanedRow = view.rows().find((row) => row.getAttribute("data-task-id") === "task-orphaned")!;
    expect(orphanedRow.textContent).toContain("失联");
    expect(orphanedRow.textContent).not.toContain("执行中");
    act(() => view.root.unmount());
  });

  it("仅有被指派任务的节点:chip 计数等于筛选命中行数,不再显示 0 却筛出任务", () => {
    const view = renderView({
      tasks: [
        task("task-1", {
          assignment: {
            assignee: { kind: "person", personId: "person_ana", nodeId: "edge-x" },
            expiresAt: "2026-10-02T00:00:00Z",
          },
        }),
        task("task-2", {
          assignment: {
            assignee: { kind: "person", personId: "person_bob", nodeId: "edge-x" },
            expiresAt: "2026-10-02T00:00:00Z",
          },
        }),
      ],
    });
    const nodeChip = view.host
      .querySelector('[data-testid="collaboration-filter-node"] span[title="edge-x"]')
      ?.closest("button") as HTMLButtonElement;
    expect(chipCount(nodeChip)).toBe("2"); // 不是 executing 计数(会是 0),是筛选命中数
    act(() => nodeChip.click());
    expect(view.rows().map((row) => row.getAttribute("data-task-id"))).toEqual(["task-1", "task-2"]);
    act(() => view.root.unmount());
  });

  it("同一 task 的指派人与 lease principal 相同:人 chip 计数与筛选行数一致(计 1 不计 2)", () => {
    const view = renderView({
      tasks: [
        task("task-both", {
          assignment: { assignee: { kind: "person", personId: "person_ana" }, expiresAt: "2026-10-02T00:00:00Z" },
          leaseActor: { principal: { personId: "person_ana" }, executor: null },
          leasePhase: "held",
        }),
      ],
    });
    const anaChip = view.host
      .querySelector('[data-testid="collaboration-filter-person"] span[title="person_ana"]')
      ?.closest("button") as HTMLButtonElement;
    expect(chipCount(anaChip)).toBe("1"); // 同 task 双重身份只计一次,筛选也只命中这一行
    act(() => anaChip.click());
    expect(view.rows()).toHaveLength(1);
    act(() => view.root.unmount());
  });

  it("会话维度如实命名「执行会话」:同一人的两个 runtime-session 是两个值,不冒充 Agent 聚合", () => {
    const view = renderView({
      tasks: [
        task("task-a", {
          leaseActor: {
            principal: { personId: "person_zeyu" },
            executor: { kind: "agent", id: "runtime-session:runtime_aaa" },
          },
          leasePhase: "held",
        }),
        task("task-b", {
          leaseActor: {
            principal: { personId: "person_zeyu" },
            executor: { kind: "agent", id: "runtime-session:runtime_bbb" },
          },
          leasePhase: "held",
        }),
      ],
    });
    const sessionDimension = view.host.querySelector('[data-testid="collaboration-filter-session"]')!;
    expect(sessionDimension.textContent).toContain("执行会话");
    expect(sessionDimension.textContent).not.toContain("Agent");
    expect(view.host.querySelector('[data-testid="collaboration-filter-agent"]')).toBeNull();
    const sessionChips = [...sessionDimension.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      button.querySelector('span[title^="runtime-session:"]'),
    );
    expect(sessionChips).toHaveLength(2);
    for (const chip of sessionChips) {
      expect(chipCount(chip)).toBe("1");
    }
    act(() => sessionChips[0]!.click());
    expect(view.rows()).toHaveLength(1);
    act(() => view.root.unmount());
  });
});
