// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkTasksTab, type WorkLeafRow } from "../src/renderer/views/workspace/WorkTasksTab.tsx";
import type { WorkSubgroup } from "../src/renderer/model/workspace-narrative.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/** 任务页分组态的行内状态标签契约(标准 §2.4 重复值不进行,S5):按状态分组时整组
 *  状态相同,行内不再贴 StatusTag;按子组分组(默认)时行内保留状态标签。 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(() => vi.restoreAllMocks());

const leaves: readonly WorkLeafRow[] = [
  {
    taskId: "task_active",
    title: "在跑的任务",
    status: "active",
    pinned: false,
    at: "2026-10-05T10:00:00.000Z",
    groupKey: "sub_a",
  },
  {
    taskId: "task_done",
    title: "已完成的任务",
    status: "done",
    pinned: false,
    at: "2026-10-05T09:00:00.000Z",
    groupKey: "sub_a",
  },
  {
    taskId: "task_review",
    title: "评审中的任务",
    status: "in_review",
    pinned: false,
    at: "2026-10-05T08:00:00.000Z",
    groupKey: "sub_b",
  },
];
const subgroups: readonly WorkSubgroup[] = [
  { key: "sub_a", title: "子组 A", loose: false, depth: 0, memberTaskIds: [], counts: {} },
] as never;

function mount(): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const props = {
    leaves,
    subgroups,
    statusFilter: "",
    groupFilter: null,
    query: "",
    agoOf: (iso: string) => iso,
    onStatusFilter: () => undefined,
    onGroupFilter: () => undefined,
    onOpenTask: () => undefined,
  };
  act(() => {
    root.render(createElement(WorkTasksTab, props));
  });
  return { host, root };
}

describe("WorkTasksTab 分组态的行内状态标签(§2.4 重复值不进行)", () => {
  it("按子组分组(默认):行内保留状态标签", () => {
    const { host, root } = mount();
    const tagged = host.querySelectorAll("[data-task-row] [data-status-tone]");
    // 混合状态的组里每行仍带自己的状态标签。
    expect(host.querySelectorAll("[data-task-row]")).toHaveLength(leaves.length);
    expect(tagged.length).toBe(leaves.length);
    act(() => root.unmount());
  });

  it("按状态分组:组头已报状态,行内不再重复贴标签", async () => {
    const { host, root } = mount();
    const select = host.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => {
      select.value = "status";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 组头(按钮)里保留状态词;行内状态标签整组消失。终态组无未完成项默认收起
    // (§1.4),展开的是 active 与 in_review 两组。
    expect(host.querySelector('[data-group="active"]')?.textContent).toContain("活跃");
    expect(host.querySelectorAll("[data-task-row]")).toHaveLength(leaves.length - 1);
    expect(host.querySelectorAll("[data-task-row] [data-status-tone]")).toHaveLength(0);
    act(() => root.unmount());
  });
});
