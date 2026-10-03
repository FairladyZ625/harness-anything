// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OverviewTaskWipBody, wipVisibleEntries, type WipFilter } from "../src/renderer/views/OverviewTaskWip.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { TaskWipRead } from "../src/api/renderer-dto.ts";

/**
 * 总览 WIP 区域行体(task_fa84b041ed175ce8e81160eea1)的行为面:数量与名单来自同一条
 * repo.tasks.wip 快照、根容器不在名单、四个占位状态各自计数且可过滤(放大层展面)、全部
 * 入口恢复名单、搜索按标题/ID、末尾条目可达且行与实体引用都接真实回调;条面是计数带 +
 * 全量名单,行点击交给宿主的放大层选择;loading/error 不冒充 0;空态明确且上限如实
 * (不写死 30)。占用数/上限与根容器页脚在区域 chrome(Region big/footer),接线行为在
 * overview-board.vitest.tsx;组件不自己发查询——宿主把快照与状态喂进来,这里直接用
 * fixture 驱动。
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

/** 过滤态由宿主持有(键盘导航与名单渲染同源):测试里用闭包模拟一个最小的宿主状态。 */
function mount(props: Partial<Parameters<typeof OverviewTaskWipBody>[0]> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onSelect = vi.fn();
  const onOpenTask = vi.fn();
  let filter: WipFilter = { group: "all", search: "" };
  const render = () =>
    act(() =>
      root!.render(
        createElement(OverviewTaskWipBody, {
          snapshot: fullSnapshot(),
          onSelect,
          onOpenTask,
          filter,
          onFilterChange: (next) => {
            filter = next;
            render();
          },
          ...props,
        }),
      ),
    );
  render();
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

describe("总览 WIP 区域行体", () => {
  it("条面:四状态计数带 + 全量名单,根容器不进名单", () => {
    const host = mount();
    // 计数带与评审区分组计数条同构:数字 + 词表标签,四个状态零计数也可见。
    const strip = host.querySelector("[data-testid='overview-task-wip'] > div")!;
    expect(textOf(strip)).toContain("8");
    expect(textOf(strip)).toContain("活跃");
    expect(textOf(strip)).toContain("9");
    expect(textOf(strip)).toContain("评审中(In Review)");
    // 全量名单:不是只展示前几条,30 条 counted 都渲染(容器内部滚动,见组件契约)。
    expect(rowIds(host)).toHaveLength(30);
    // 根容器不进名单(分母与页脚在区域 chrome,见 overview-board 接线测试)。
    const ids = rowIds(host);
    expect(ids).not.toContain("task_root_declared");
    expect(ids).not.toContain("task_root_derived");
    // 条面没有过滤控件:控制行在放大层展面。
    expect(host.querySelector("[data-testid='overview-task-wip-search']")).toBeNull();
    unmount();
  });

  it("末尾第 30 条可达且双路接真实回调:行面 onSelect、实体引用 onOpenTask", () => {
    const onSelect = vi.fn();
    const onOpenTask = vi.fn();
    const host = mount({ onSelect, onOpenTask });
    const lastId = rowIds(host)[29]!;
    expect(lastId).toBe("task_wip29");
    // 行主点击面(DenseRow 的内容按钮,行内第一个 button):交给宿主(条面打开放大层)。
    const row = [...host.querySelectorAll("[data-dense-row]")][29]!;
    act(() => (row.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith(lastId);
    // 行右侧实体引用(EntityRefLink,悬停带完整 canonical 引用):直接导航。
    const ref = row.querySelector(`button[title*='task/${lastId}']`) as HTMLButtonElement;
    expect(ref).not.toBeNull();
    act(() => ref.click());
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledWith(lastId);
    unmount();
  });

  it("放大层展面:分组按钮带计数,切组过滤名单,「全部」恢复全量", () => {
    const host = mount({ inFocus: true });
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
    const host = mount({ inFocus: true });
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
    const host = mount({ inFocus: true });
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

  it("过滤不遗留到条面:放大层带着搜索关层,条面仍渲染全量名单", () => {
    // 宿主状态里 filter 还留着搜索词(关层不清态):条面(inFocus=false)不受它影响。
    const host = mount({ inFocus: false, filter: { group: "blocked", search: "末尾" } });
    expect(rowIds(host)).toHaveLength(30);
    expect(host.querySelector("[data-testid='overview-task-wip-empty']")).toBeNull();
    unmount();
  });

  it("loading 是真实的 pending 面,不冒充 0", () => {
    const host = mount({ snapshot: undefined, loading: true });
    expect(textOf(host.querySelector("[data-testid='overview-task-wip-loading']"))).toContain("正在读取");
    expect(host.querySelector("[data-testid='overview-task-wip-list']")).toBeNull();
    unmount();
  });

  it("读取失败是失败面,不冒充 0;有旧快照时保留名单并显形失败", () => {
    const host = mount({ snapshot: undefined, error: "bridge unavailable" });
    const notice = host.querySelector("[data-testid='overview-task-wip-error']")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(textOf(notice)).toContain("bridge unavailable");
    expect(host.querySelector("[data-testid='overview-task-wip-list']")).toBeNull();
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
    // 上限不是写死的 30:整个行体不出现 30。
    expect(textOf(host)).not.toContain("30");
    expect(host.querySelector("[data-testid='overview-task-wip-list']")).toBeNull();
    unmount();
  });

  it("零计数的状态组仍然可见可点,给出该组空态", () => {
    const snapshot = fullSnapshot();
    const host = mount({
      inFocus: true,
      snapshot: { ...snapshot, counted: snapshot.counted.filter((entry) => entry.status !== "blocked") },
    });
    act(() => chip(host, "已阻塞 0")!.click());
    const list = host.querySelector("[data-testid='overview-task-wip-list']")!;
    expect(textOf(list)).toContain("该状态下没有占位任务");
    unmount();
  });

  it("wipVisibleEntries 是名单与键盘导航共用的可见集合:分组/搜索叠加,隐藏行不在集合内", () => {
    const counted = fullSnapshot().counted;
    expect(wipVisibleEntries(counted, { group: "all", search: "" })).toHaveLength(30);
    expect(
      wipVisibleEntries(counted, { group: "blocked", search: "" }).every((entry) => entry.status === "blocked"),
    ).toBe(true);
    expect(wipVisibleEntries(counted, { group: "active", search: "wip05" }).map(({ taskId }) => taskId)).toEqual([
      "task_wip05",
    ]);
    // 组外命中不出现(分组先收窄,搜索在其内匹配);无命中给空集合(键盘导航随之停)。
    expect(wipVisibleEntries(counted, { group: "blocked", search: "wip05" })).toEqual([]);
    expect(wipVisibleEntries(counted, { group: "all", search: "不存在的关键词" })).toEqual([]);
  });

  it("成员集钉死线上词表:WIP_STATUS_ORDER 与 counted 的状态词一致(防 kernel 漂移)", () => {
    const statuses = new Set(fullSnapshot().counted.map((entry) => entry.status));
    expect([...statuses].every((status) => WIP_STATUS_ORDER.includes(status))).toBe(true);
    expect(WIP_STATUS_ORDER).toHaveLength(4);
  });
});
