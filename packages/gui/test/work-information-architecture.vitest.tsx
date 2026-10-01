// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { collectWork, workIndexOf } from "../src/renderer/model/work-collections.ts";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { adaptProjectionRows } from "../src/renderer/task-adapter.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { PinButton } from "../src/renderer/components/PinButton.tsx";

// 默认每个 fixture 是声明工作根(workId 自指,daemon 工作索引的落点);子任务在 patch 里给所属工作。
const task = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: taskId,
    canonicalStatus: "planned",
    taskClass: "work",
    workId: taskId,
    lastKnownAt: "2099-01-01",
    createdAt: "2026-01-01",
    events: [],
    ...patch,
  }) as TaskRow;

describe("work information architecture", () => {
  it("sorts all descendant lifecycle activity ahead of creation, ignores snapshot updates, and counts descendant leaves once", () => {
    const rows = [
      task("new", { createdAt: "2099-01-01" }),
      task("old"),
      task("root"),
      task("nested", { parentTaskId: "root", canonicalStatus: "done" }),
      task("leaf", {
        parentTaskId: "nested",
        workId: "nested",
        taskClass: "standard",
        canonicalStatus: "cancelled",
        events: [{ at: "2026-02-01", taskId: "leaf", projectId: "p", summary: "Gate" }],
      }),
      task("root-only", { events: [{ at: "2026-01-15", taskId: "root-only", projectId: "p", summary: "Review" }] }),
    ];
    const result = collectWork(rows);
    expect(result.groups.map(({ task }) => task.taskId)).toEqual(["nested", "root", "root-only", "new", "old"]);
    expect(result.groups.find(({ task }) => task.taskId === "root")).toMatchObject({
      descendants: 2,
      leaves: 1,
      counts: { cancelled: 1 },
      activity: { taskId: "leaf" },
    });
    expect(result.groups.find(({ task }) => task.taskId === "root-only")).toMatchObject({ leaves: 0, counts: {} });
  });

  it("uses every approved lifecycle timestamp from the real adapter", () => {
    const fields = [
      ["executions", { executionId: "e", claimedAt: "2026-02-01" }],
      ["executions", { executionId: "e", claimedAt: "2026-01-01", submittedAt: "2026-02-01" }],
      ["executions", { executionId: "e", claimedAt: "2026-01-01", closedAt: "2026-02-01" }],
      ["reviews", { reviewId: "r", reviewedAt: "2026-02-01" }],
      ["consents", { consentId: "c", consentedAt: "2026-02-01" }],
      ["codeDocWitnesses", { schema: "code-doc-witness/v1", witnessId: "w", reconciledAt: "2026-02-01" }],
      ["codeDocWitnesses", { schema: "code-doc-repoint/v1", recordId: "w", repointedAt: "2026-02-01" }],
      ["gateWitnesses", { gateId: "g", verifiedAt: "2026-02-01" }],
    ] as const;
    for (const [field, witness] of fields) {
      const snapshot = {
        task: {
          title: field,
          status: "planned",
          taskClass: "work",
          metadata: {},
          createdBy: { principal: { personId: "p" } },
        },
        executions: [],
        reviews: [],
        consents: [],
        codeDocWitnesses: [],
        gateWitnesses: [],
        [field]: [witness],
      };
      const adapted = adaptProjectionRows(
        [
          {
            taskId: field,
            snapshot,
            createdAt: "2026-01-01",
            updatedAt: "2099-01-01",
            placement: { spawningDecisionIds: [], productLines: [], provenance: [] },
            closeoutAssessment: { gates: [] },
            blockingAssessment: {},
          },
        ] as never,
        "p",
        "ready",
        workIndexOf({
          schema: "daemon.work-index/v1",
          ok: true,
          status: "ready",
          works: [
            {
              taskId: field,
              title: field,
              status: "planned",
              root: "declared",
              parentTaskId: null,
              taskCount: 0,
              counts: { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 },
              lastActivityAt: "2099-01-01",
              memberTaskIds: [],
            },
          ],
          watermark: 1,
          sourceRevision: 1,
          warnings: [],
        }),
      );
      expect(collectWork(adapted).groups[0]?.activity?.at).toBe("2026-02-01");
    }
  });

  it("renders every work as one card without queries, keeps terminal works reachable, and sorts by progress", () => {
    const host = document.createElement("div"),
      root = createRoot(host),
      opened: string[] = [];
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => task(`group-${String(i).padStart(2, "0")}`)),
      task("done-group"),
      task("done-group-child", {
        parentTaskId: "done-group",
        taskClass: "standard",
        workId: "done-group",
        canonicalStatus: "done",
      }),
      task("cancel-group", { canonicalStatus: "cancelled" }),
      task("child", { parentTaskId: "group-29", taskClass: "standard", workId: "group-29" }),
      task("historic-solo", { taskClass: "standard", canonicalStatus: "done", workId: undefined }),
    ];
    act(() =>
      root.render(
        <WorkView
          tasks={rows}
          repoId="p"
          ready
          onOpenTask={(id) => opened.push(id)}
          catalog={undefined}
          catalogError={null}
          daemonState="responsive"
          onRefreshLedger={() => {}}
          agenda={undefined}
        />,
      ),
    );
    // 一个工作一张卡、不分页;终端工作与历史工作不再被状态筛选藏起来。
    const rowIds = () =>
      [...host.querySelectorAll('[data-testid="work-row"]')].map((row) => row.getAttribute("data-work-id"));
    expect(rowIds()).toHaveLength(32);
    expect(rowIds()).toContain("done-group");
    expect(rowIds()).toContain("cancel-group");
    // 独立任务不在工作页;它属于任务列表页。
    expect(host.textContent).not.toContain("historic-solo");
    const select = (label: string, value: string) =>
      act(() => {
        const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    select("工作排序", "progress");
    // 进度升序:唯一还有未完成叶子的 group-29(0/1)排在已全部完成的 done-group(1/1)之前。
    expect(rowIds()?.indexOf("group-29")).toBeLessThan(rowIds()?.indexOf("done-group") ?? -1);
    const doneGroupRow = host.querySelector('[data-testid="work-row"][data-work-id="done-group"]')!;
    expect(doneGroupRow.querySelector('[data-testid="work-progress"]')!.textContent).toBe("1/1");
    act(() => doneGroupRow.querySelector<HTMLButtonElement>("button")!.click());
    expect(opened).toEqual(["done-group"]);
    act(() => root.unmount());
  });

  it("gives pin actions visible text and preserves the caller callback", () => {
    const host = document.createElement("div"),
      root = createRoot(host);
    let calls = 0;
    for (const pinned of [false, true]) {
      act(() => root.render(<PinButton pinned={pinned} testId="pin" onClick={() => calls++} />));
      const button = host.querySelector("button")!;
      expect(button.textContent).toBe(pinned ? "解除置顶" : "置顶");
      expect(button.querySelector("svg")).not.toBeNull();
      act(() => button.click());
    }
    expect(calls).toBe(2);
    // compact 供侧栏那种窄容器用:去掉文字,但边框与正文对比度保留——找不到它的原因
    // 是淡色无边框,不是没有文字。
    act(() => root.render(<PinButton pinned compact testId="pin" onClick={() => calls++} />));
    const compact = host.querySelector("button")!;
    expect(compact.textContent).toBe("");
    expect(compact.getAttribute("aria-label")).toBe("解除置顶");
    expect(compact.className).toContain("border-border");
    expect(compact.className).not.toContain("text-text-faint");
    act(() => root.unmount());
  });
});
