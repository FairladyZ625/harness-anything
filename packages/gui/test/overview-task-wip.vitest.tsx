// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OverviewTaskWip } from "../src/renderer/views/OverviewTaskWip.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskWipRead } from "../src/api/renderer-dto.ts";

/**
 * 总览 WIP 组件(task_fa84b041ed175ce8e81160eea1)的行为面:占用数与上限来自同一条
 * repo.tasks.wip 快照、根容器不混入分母、四个占位状态各自计数且可过滤、全部入口恢复
 * 名单、搜索按标题/ID、末尾条目可达且行与实体引用都接真实导航回调;loading/error 不
 * 冒充 0;空态明确且上限如实(不写死 30)。组件不自己发查询——宿主把快照与状态喂进来,
 * 这里直接用 fixture 驱动。
 */

type TaskWipEntry = TaskWipRead["counted"][number];
type TaskWipStatus = TaskWipEntry["status"];

const WIP_STATUS_ORDER: readonly TaskWipStatus[] = ["active", "submitted", "in_review", "blocked"];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

/** 30 条占位跨 4 状态(8/6/9/7),根容器两条(声明/派生各一)不进 counted。 */
function fullSnapshot(): TaskWipRead {
  const plan: readonly [TaskWipStatus, number][] = [
    ["active", 8],
    ["submitted", 6],
    ["in_review", 9],
    ["blocked", 7],
  ];
  let index = 0;
  const counted: TaskWipEntry[] = [];
  for (const [status, count] of plan) {
    for (let n = 0; n < count; n += 1) {
      counted.push({
        taskId: `task_wip${String(index).padStart(2, "0")}`,
        status,
        title: `占位任务 ${index}`,
      });
      index += 1;
    }
  }
  // 让第 30 条(末尾)带一个可精确搜索的标题。
  counted[counted.length - 1] = { ...counted[counted.length - 1]!, title: "末尾的长标题占位任务" };
  return {
    ok: true,
    limit: 30,
    limitLabel: "settings.tasks.wipLimit",
    counted,
    roots: [
      { taskId: "task_root_declared", reason: "declared", directChildCount: 5, threshold: 3 },
      { taskId: "task_root_derived", reason: "derived", directChildCount: 4, threshold: 3 },
    ],
    threshold: 3,
  };
}

let root: Root | null = null;

function mount(props: Partial<Parameters<typeof OverviewTaskWip>[0]> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onOpenTask = vi.fn();
  act(() =>
    root!.render(
      createElement(OverviewTaskWip, {
        snapshot: fullSnapshot(),
        onOpenTask,
        ...props,
      }),
    ),
  );
  return container;
}

const unmount = () => act(() => root?.unmount());
const textOf = (element: Element | null | undefined) => element?.textContent ?? "";
/** 行 id 取自行右侧实体引用(EntityRefLink 悬停始终带完整 canonical 引用)。 */
const rowIds = (host: HTMLElement) =>
  [...host.querySelectorAll("[data-testid='overview-task-wip-list'] [data-dense-row]")].map((row) => {
    const ref = row.querySelector("button[title*='task/']") as HTMLButtonElement | null;
    const title = ref?.title ?? "";
    return title.slice(title.lastIndexOf("task/") + "task/".length);
  });
const chip = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("[role='group'] button")].find((button) => textOf(button) === label);

describe("总览 WIP 组件", () => {
  it("占用与上限来自快照:满额 30/30 显形,根容器不混入分母,30 条全部在名单里", () => {
    const host = mount();
    const occupancy = host.querySelector("[data-testid='overview-task-wip-occupancy']")!;
    expect(textOf(occupancy)).toBe("30/30");
    expect(occupancy.getAttribute("data-full")).toBe("true");
    expect(textOf(host)).toContain("满额");
    // 全量名单:不是只展示前几条,30 条 counted 都渲染(容器内部滚动,见组件契约)。
    expect(rowIds(host)).toHaveLength(30);
    // 根容器只在页脚排除说明里,不进名单、不进分母(占用是 30 不是 32)。
    const ids = rowIds(host);
    expect(ids).not.toContain("task_root_declared");
    expect(ids).not.toContain("task_root_derived");
    const footer = host.querySelector("[data-testid='overview-task-wip-footer']")!;
    expect(textOf(footer)).toContain("根容器 2");
    expect(textOf(footer)).toContain("声明 1");
    expect(textOf(footer)).toContain("派生 1");
    // 上限来源与根判定阈值在悬停说明里可达。
    expect(occupancy.getAttribute("title")).toContain("settings.tasks.wipLimit");
    expect(footer.getAttribute("title")).toContain("task_root_declared");
    unmount();
  });

  it("末尾第 30 条可达且导航接真实回调:行与实体引用两条路都调 onOpenTask", () => {
    const onOpenTask = vi.fn();
    const host = mount({ onOpenTask });
    const lastId = rowIds(host)[29]!;
    expect(lastId).toBe("task_wip29");
    // 行主点击面(DenseRow 的内容按钮,行内第一个 button)。
    const row = [...host.querySelectorAll("[data-dense-row]")][29]!;
    act(() => (row.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith(lastId);
    // 行右侧实体引用(EntityRefLink,悬停带完整 canonical 引用)。
    const ref = row.querySelector(`button[title*='task/${lastId}']`) as HTMLButtonElement;
    expect(ref).not.toBeNull();
    act(() => ref.click());
    expect(onOpenTask).toHaveBeenCalledTimes(2);
    expect(onOpenTask).toHaveBeenLastCalledWith(lastId);
    unmount();
  });

  it("四个状态各自计数,点统计按钮切组,「全部」恢复全量名单", () => {
    const host = mount();
    for (const [label, expected] of [
      ["活跃 8", 8],
      ["待初审(Submitted) 6", 6],
      ["评审中(In Review) 9", 9],
      ["已阻塞 7", 7],
      ["全部 30", 30],
    ] as const) {
      const button = chip(host, label);
      expect(button, label).toBeDefined();
      act(() => button!.click());
      expect(rowIds(host)).toHaveLength(expected);
    }
    // 切组后名单只剩该状态:取一个非默认组验证内容而不只数行数。
    act(() => chip(host, "已阻塞 7")!.click());
    const blocked = host.querySelector("[data-testid='overview-task-wip-list']")!;
    expect(blocked.querySelectorAll('[data-status-tone="bad"]')).toHaveLength(7);
    unmount();
  });

  it("搜索按标题或任务 ID 过滤,清空恢复;组过滤与搜索叠加", () => {
    const host = mount();
    const type = (value: string) => {
      const input = host.querySelector("[data-testid='overview-task-wip-search']") as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    // 先按状态切组,再搜索:叠加过滤(wip05 是唯一命中该片段的任务 ID)。
    act(() => chip(host, "活跃 8")!.click());
    type("wip05");
    expect(rowIds(host)).toEqual(["task_wip05"]);
    // 组外同名片段不出现:回「全部」后仍只有这一条(按 ID 搜索跨组精确命中)。
    act(() => chip(host, "全部 30")!.click());
    expect(rowIds(host)).toEqual(["task_wip05"]);
    // 中文标题关键词搜索。
    type("末尾的长标题");
    expect(rowIds(host)).toEqual(["task_wip29"]);
    type("");
    expect(rowIds(host)).toHaveLength(30);
    unmount();
  });

  it("搜索无命中给明确空态,不与「工作台空闲」混淆", () => {
    const host = mount();
    const input = host.querySelector("[data-testid='overview-task-wip-search']") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "不存在的关键词");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const list = host.querySelector("[data-testid='overview-task-wip-list']")!;
    expect(textOf(list)).toContain("没有匹配「不存在的关键词」");
    expect(textOf(host)).not.toContain("工作台空闲");
    unmount();
  });

  it("loading 是真实的 pending 面,不冒充 0", () => {
    const host = mount({ snapshot: undefined, loading: true });
    expect(textOf(host.querySelector("[data-testid='overview-task-wip-loading']"))).toContain("正在读取");
    expect(textOf(host.querySelector("[data-testid='overview-task-wip-occupancy']"))).toBe("…");
    expect(host.querySelector("[data-testid='overview-task-wip-list']")).toBeNull();
    expect(textOf(host)).not.toContain("0/");
    unmount();
  });

  it("读取失败是失败面,不冒充 0;有旧快照时保留名单并显形失败", () => {
    const host = mount({ snapshot: undefined, error: "bridge unavailable" });
    const notice = host.querySelector("[data-testid='overview-task-wip-error']")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(textOf(notice)).toContain("bridge unavailable");
    expect(textOf(host.querySelector("[data-testid='overview-task-wip-occupancy']"))).toBe("—");
    expect(textOf(host)).not.toContain("0/");
    unmount();

    const stale = mount({ error: "projection lag" });
    expect(textOf(stale.querySelector("[data-testid='overview-task-wip-error']"))).toContain("上一次成功的快照");
    expect(rowIds(stale)).toHaveLength(30);
    unmount();
  });

  it("空态明确且上限如实:counted 为 0 时显示空闲说明,上限用快照值不写死 30", () => {
    const host = mount({
      snapshot: {
        ok: true,
        limit: 12,
        limitLabel: "HARNESS_TASK_WIP_LIMIT",
        counted: [],
        roots: [],
        threshold: 3,
      },
    });
    expect(textOf(host)).toContain("工作台空闲");
    expect(textOf(host)).toContain("12");
    expect(textOf(host)).toContain("HARNESS_TASK_WIP_LIMIT");
    // 上限不是写死的 30:整个组件不出现 30。
    expect(textOf(host)).not.toContain("30");
    expect(host.querySelector("[data-testid='overview-task-wip-list']")).toBeNull();
    unmount();
  });

  it("零计数的状态组仍然可见可点,给出该组空态", () => {
    const snapshot = fullSnapshot();
    const host = mount({
      snapshot: { ...snapshot, counted: snapshot.counted.filter((entry) => entry.status !== "blocked") },
    });
    expect(textOf(host.querySelector("[data-testid='overview-task-wip-occupancy']"))).toBe("23/30");
    act(() => chip(host, "已阻塞 0")!.click());
    const list = host.querySelector("[data-testid='overview-task-wip-list']")!;
    expect(textOf(list)).toContain("该状态下没有占位任务");
    unmount();
  });

  it("成员集钉死线上词表:WIP_STATUS_ORDER 与 counted 的状态词一致(防 kernel 漂移)", () => {
    const statuses = new Set(fullSnapshot().counted.map((entry) => entry.status));
    expect([...statuses].every((status) => WIP_STATUS_ORDER.includes(status))).toBe(true);
    expect(WIP_STATUS_ORDER).toHaveLength(4);
  });
});
