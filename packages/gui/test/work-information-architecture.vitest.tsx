// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { collectWork } from "../src/renderer/model/work-collections.ts";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { adaptProjectionRows } from "../src/renderer/task-adapter.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { PinButton } from "../src/renderer/components/PinButton.tsx";

const task = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: taskId,
    canonicalStatus: "planned",
    taskClass: "milestone",
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
          taskClass: "milestone",
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
            placement: { spawningDecisionIds: [], moduleKeys: [], productLines: [], provenance: [] },
            closeoutAssessment: { gates: [] },
            blockingAssessment: {},
          },
        ] as never,
        "p",
      );
      expect(collectWork(adapted).groups[0]?.activity?.at).toBe("2026-02-01");
    }
  });

  it("bounds pages, exposes historical independent work, and sorts by leaf task volume without queries", () => {
    const host = document.createElement("div"),
      root = createRoot(host),
      opened: string[] = [];
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => task(`group-${String(i).padStart(2, "0")}`)),
      task("done-group", { canonicalStatus: "done" }),
      task("cancel-group", { canonicalStatus: "cancelled" }),
      task("child", { parentTaskId: "group-29", taskClass: "standard" }),
      task("historic-solo", { taskClass: "standard", canonicalStatus: "done" }),
    ];
    act(() =>
      root.render(
        <WorkView
          tasks={rows}
          repoId="p"
          projectName="P"
          ready
          onOpenGroup={(id) => opened.push(id)}
          onOpenTask={(id) => opened.push(id)}
        />,
      ),
    );
    const cards = () => [...host.querySelectorAll('[data-testid="work-group-card"]')];
    expect(cards()).toHaveLength(24);
    expect(cards().some((c) => c.textContent?.includes("done-group"))).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>('nav[aria-label="任务组分页"] button:last-child')!.click());
    expect(cards()).toHaveLength(6);
    const select = (label: string, value: string) =>
      act(() => {
        const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    select("工作排序", "size");
    expect(cards()[0]?.textContent).toContain("group-29");
    select("工作状态", "all");
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="isolated-work"] button')!.click());
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>('[data-testid="isolated-work"] button')]
        .find((b) => b.textContent === "historic-solodone")!
        .click(),
    );
    expect(opened).toEqual(["historic-solo"]);
    expect(host.textContent).toContain("执行 · 评审 · 签发 · 门见证");
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
