// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

setActiveLocale("zh-CN");

/**
 * S4 工作页(task_ced628eaa5677ebb4c3cf61fab):每个工作一行健康摘要、默认只看需要关注、
 * 按标题与任务搜索、筛选项带计数、排序默认用 S1 的注意力分(原型 v1「工作」tab 与 v4
 * 放大的「工作」区域为交互样张)。注意力条目来自 daemon 议程读面的 attentionItems,
 * 页面不自己打分。
 */

const task = (taskId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  ({
    taskId,
    title: taskId,
    projectId: "p",
    canonicalStatus: "planned",
    taskClass: "work",
    workId: taskId,
    lastKnownAt: "2020-01-01",
    createdAt: "2026-01-01",
    events: [],
    ...patch,
  }) as TaskRow;

const member = (taskId: string, workId: string, patch: Partial<TaskRow> = {}): TaskRow =>
  task(taskId, { workId, parentTaskId: workId, taskClass: "standard", ...patch });

const RECENT = "2999-01-01T00:00:00.000Z";

const attention = (
  ref: string,
  kind: string,
  region: string,
  workTaskId: string | null,
  score: number,
  title: string,
) => ({ ref, title, kind, region, workTaskId, attention: { score, reasons: [] } });

// 件套:等你(u)、在跑(r)、停滞(s)、安静(q)、可收尾(f)。
const ROWS: TaskRow[] = [
  task("w-urgent"),
  member("t-await", "w-urgent", { canonicalStatus: "active" }),
  member("t-blocked", "w-urgent", { canonicalStatus: "blocked" }),
  task("w-running", { lastKnownAt: RECENT }),
  member("t-run", "w-running", { canonicalStatus: "active", activeExecutionId: "exec-1" }),
  task("w-stale", { canonicalStatus: "active" }),
  task("w-quiet"),
  member("t-quiet-planned", "w-quiet", { canonicalStatus: "planned" }),
  task("w-finished"),
  member("t-finished-done", "w-finished", { canonicalStatus: "done" }),
];

const AGENDA = {
  ok: true,
  status: "ready",
  attentionItems: [
    attention("relation/r1", "awaiting-you", "mine", "w-urgent", 130, "等待你答复的事项"),
    attention("task/w-stale", "stalled", "stuck", "w-stale", 58, "进行中但停滞"),
  ],
  page: { sourceLimit: 200, cursor: null, nextCursor: null },
  watermark: 1,
  sourceRevision: 1,
} as unknown as AgendaSuccess;

interface Mounted {
  readonly host: HTMLElement;
  readonly opened: string[];
  rerender: (patch: { agenda?: AgendaSuccess }) => void;
  unmount: () => void;
}

function mountWorkView(initial: { agenda?: AgendaSuccess } = {}): Mounted {
  const host = document.createElement("div"),
    root = createRoot(host),
    opened: string[] = [];
  let agenda = initial.agenda;
  const render = () =>
    act(() =>
      root.render(
        <WorkView
          tasks={ROWS}
          repoId="p"
          projectName="P"
          ready
          onOpenTask={(id) => opened.push(id)}
          catalog={undefined}
          catalogError={null}
          daemonState="responsive"
          onRefreshLedger={() => {}}
          agenda={agenda}
        />,
      ),
    );
  render();
  return {
    host,
    opened,
    rerender: (patch) => {
      agenda = patch.agenda;
      render();
    },
    unmount: () => act(() => root.unmount()),
  };
}

const rowIds = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid="work-row"]')].map((row) => row.getAttribute("data-work-id"));

const chip = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll('[data-testid="work-filter-chips"] button')].find((button) =>
    button.textContent?.startsWith(label),
  );
  expect(found, `missing filter chip ${label}`).toBeTruthy();
  return found!;
};

const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

const type = (host: HTMLElement, value: string) => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索工作"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("S4 工作页:默认只看需要关注", () => {
  it("默认筛选「需要关注」,其余工作折叠成一行,点开转到全部", () => {
    const view = mountWorkView({ agenda: AGENDA });
    expect(rowIds(view.host)).toEqual(["w-urgent", "w-stale", "w-running"]);
    const quiet = view.host.querySelector('[data-testid="work-quiet"]')!;
    expect(quiet.textContent).toContain("其余 2 个工作近期安静");
    click(quiet);
    expect(rowIds(view.host)).toEqual(["w-urgent", "w-stale", "w-running", "w-finished", "w-quiet"]);
    expect(view.host.textContent).not.toContain("近期安静");
    view.unmount();
  });

  it("筛选项各带计数,选中即过滤", () => {
    const view = mountWorkView({ agenda: AGENDA });
    for (const [label, expected] of [
      ["需要关注", ["w-urgent", "w-stale", "w-running"]],
      ["需要我", ["w-urgent"]],
      ["有阻塞", ["w-urgent"]],
      ["24 小时在动", ["w-running"]],
      ["停滞", ["w-stale"]],
      ["可收尾", ["w-finished"]],
      ["全部", ["w-urgent", "w-stale", "w-running", "w-finished", "w-quiet"]],
    ] as const) {
      expect(chip(view.host, label).textContent).toBe(label + expected.length);
    }
    click(chip(view.host, "需要我"));
    expect(rowIds(view.host)).toEqual(["w-urgent"]);
    view.unmount();
  });
});

describe("S4 工作页:一行健康摘要与注意力排序", () => {
  it("默认按注意力分排序;行内有等你标记、在跑 agent、停滞标记与最后活动", () => {
    const view = mountWorkView({ agenda: AGENDA });
    const rowOf = (id: string) => view.host.querySelector(`[data-testid="work-row"][data-work-id="${id}"]`)!;
    expect(rowIds(view.host)).toEqual(["w-urgent", "w-stale", "w-running"]);
    expect(rowOf("w-urgent").textContent).toContain("1 件等你");
    expect(rowOf("w-urgent").textContent).toContain("有阻塞");
    expect(rowOf("w-running").textContent).toContain("1 个 agent");
    expect(rowOf("w-stale").textContent).toContain("停滞");
    for (const id of ["w-urgent", "w-stale", "w-running"]) {
      expect(rowOf(id).querySelector('[data-testid="work-progress"]')).toBeTruthy();
      expect(rowOf(id).querySelector('[data-testid="work-last-activity"]')).toBeTruthy();
    }
    expect(rowOf("w-urgent").querySelector('[data-segment="blocked"]')).toBeTruthy();
    click(chip(view.host, "可收尾"));
    expect(rowOf("w-finished").textContent).toContain("可收尾");
    view.unmount();
  });

  it("展开一行看到执行/待审/阻塞/计划数、注意列表与「打开工作」", () => {
    const view = mountWorkView({ agenda: AGENDA });
    const row = view.host.querySelector('[data-testid="work-row"][data-work-id="w-urgent"]')!;
    expect(row.querySelector('[data-testid="work-row-body"]')).toBeNull();
    click(row.querySelector('[data-testid="work-row-toggle"]')!);
    const body = row.querySelector('[data-testid="work-row-body"]')!;
    expect(body.textContent).toContain("进行中 1");
    expect(body.textContent).toContain("待审 0");
    expect(body.textContent).toContain("阻塞 1");
    expect(body.textContent).toContain("计划中 0");
    expect(body.textContent).toContain("等待你答复的事项");
    expect(body.textContent).toContain("130");
    click(body.querySelector('[data-testid="work-open"]')!);
    expect(view.opened).toEqual(["w-urgent"]);
    view.unmount();
  });

  it("没有议程读面时仍按在跑/阻塞/停滞排出健康序,不显示等你计数", () => {
    const view = mountWorkView();
    expect(rowIds(view.host)).toEqual(["w-running", "w-urgent", "w-stale"]);
    expect(view.host.querySelector('[data-testid="work-row"][data-work-id="w-urgent"]')?.textContent).not.toContain(
      "件等你",
    );
    view.unmount();
  });
});

describe("S4 工作页:搜索同时匹配工作标题与任务标题", () => {
  it("命中子任务的工作保留,命中任务显示在所属工作下,未命中的工作隐藏", () => {
    const view = mountWorkView({ agenda: AGENDA });
    type(view.host, "t-await");
    expect(rowIds(view.host)).toEqual(["w-urgent"]);
    const hits = view.host.querySelectorAll('[data-testid="work-hit"]');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.textContent).toContain("t-await");
    type(view.host, "不存在的词");
    expect(rowIds(view.host)).toEqual([]);
    expect(view.host.textContent).toContain("没有匹配的工作");
    view.unmount();
  });

  it("工作标题命中同样收窄列表,摘要行给出工作总数与有事等你的工作数", () => {
    const view = mountWorkView({ agenda: AGENDA });
    expect(view.host.querySelector('[data-testid="work-summary"]')?.textContent).toBe("5 个工作 · 1 个有事等你");
    type(view.host, "w-running");
    expect(rowIds(view.host)).toEqual(["w-running"]);
    view.unmount();
  });
});
