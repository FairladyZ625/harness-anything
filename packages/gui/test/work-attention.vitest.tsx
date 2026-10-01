// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { workTier, WORK_TIERS, type WorkHealth } from "../src/renderer/model/work-collections.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

setActiveLocale("zh-CN");

/**
 * 工作页:每个工作一张概况卡,按注意力分三组(需要你看的大卡、在推进的小卡、可收尾的
 * 小方块);筛选默认「全部」并作用于三组,按标题与任务搜索,排序默认用 S1 的注意力分。
 * 注意力条目来自 daemon 议程读面的 attentionItems,页面不自己打分。
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

const tierIds = (host: HTMLElement, tier: string) =>
  [...host.querySelectorAll(`[data-testid="work-tier-${tier}"] [data-testid="work-row"]`)].map((row) =>
    row.getAttribute("data-work-id"),
  );

describe("workTier:三组互斥且并集为全集", () => {
  it("每种健康组合恰好落一组:等你/阻塞/停滞压过可收尾,其余按是否全部收口分", () => {
    const item = AGENDA.attentionItems[0]!;
    const seen = new Set<string>();
    for (const mine of [[], [item]])
      for (const blocked of [false, true])
        for (const stale of [false, true])
          for (const finished of [false, true]) {
            const health: Pick<WorkHealth, "mine" | "blocked" | "stale" | "finished"> = {
                mine,
                blocked,
                stale,
                finished,
              },
              tier = workTier(health);
            expect(WORK_TIERS.filter((candidate) => candidate === tier)).toHaveLength(1);
            expect(tier).toBe(mine.length > 0 || blocked || stale ? "attention" : finished ? "closable" : "progress");
            seen.add(tier);
          }
    expect([...seen].sort()).toEqual([...WORK_TIERS].sort());
  });
});

describe("工作页:三组概况卡", () => {
  it("默认「全部」:每个工作只出现一次,三组个数之和等于工作总数,卡的大小跟着组走", () => {
    const view = mountWorkView({ agenda: AGENDA });
    expect(tierIds(view.host, "attention")).toEqual(["w-urgent", "w-stale"]);
    expect(tierIds(view.host, "progress")).toEqual(["w-running", "w-quiet"]);
    expect(tierIds(view.host, "closable")).toEqual(["w-finished"]);
    expect(rowIds(view.host)).toEqual(["w-urgent", "w-stale", "w-running", "w-quiet", "w-finished"]);
    for (const [tier, size, heading] of [
      ["attention", "large", "需要你看2"],
      ["progress", "small", "在推进2"],
      ["closable", "tile", "可收尾1"],
    ] as const) {
      const group = view.host.querySelector(`[data-testid="work-tier-${tier}"]`)!;
      expect(group.querySelector("h2")!.textContent).toBe(heading);
      for (const card of group.querySelectorAll('[data-testid="work-row"]'))
        expect(card.getAttribute("data-summary-card")).toBe(size);
    }
    // 旧的行展开体与安静折叠行都不存在。
    for (const gone of ["work-row-toggle", "work-row-body", "work-open", "work-quiet"])
      expect(view.host.querySelector(`[data-testid="${gone}"]`)).toBeNull();
    view.unmount();
  });

  it("筛选项各带计数,选中即过滤并作用于三组;没有成员的组整段不出现", () => {
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
    expect(chip(view.host, "全部").getAttribute("aria-pressed")).toBe("true");
    click(chip(view.host, "需要关注"));
    expect(rowIds(view.host)).toEqual(["w-urgent", "w-stale", "w-running"]);
    expect(view.host.querySelector('[data-testid="work-tier-closable"]')).toBeNull();
    click(chip(view.host, "需要我"));
    expect(rowIds(view.host)).toEqual(["w-urgent"]);
    view.unmount();
  });
});

describe("工作页:卡上的概况与注意力排序", () => {
  it("大卡报为什么要你看,小卡报在跑数,小方块报完成数;每张卡都有进度与最后活动", () => {
    const view = mountWorkView({ agenda: AGENDA });
    const rowOf = (id: string) => view.host.querySelector(`[data-testid="work-row"][data-work-id="${id}"]`)!;
    const reasons = (id: string) =>
      [...rowOf(id).querySelectorAll('[data-testid="work-flags"] > p')].map((line) => line.textContent);
    // 既等你又阻塞:两句都写,各占一行;阻塞直接点名卡住的任务。
    expect(reasons("w-urgent")).toEqual(["等你答复等待你答复的事项", "有阻塞t-blocked"]);
    expect(rowOf("w-urgent").getAttribute("style")).toContain("--status-edge");
    expect(reasons("w-stale")[0]).toMatch(/^停滞\d+ 天没有活动$/u);
    expect(rowOf("w-running").textContent).toContain("1 个 agent 在跑");
    expect(rowOf("w-quiet").textContent).toContain("计划 1 · 无 agent 在跑");
    expect(rowOf("w-finished").textContent).toContain("1/1");
    for (const id of ["w-urgent", "w-stale", "w-running", "w-quiet", "w-finished"]) {
      expect(rowOf(id).querySelector('[data-testid="work-progress"]'), id).toBeTruthy();
      expect(rowOf(id).querySelector('[data-testid="work-last-activity"]'), id).toBeTruthy();
    }
    expect(rowOf("w-urgent").querySelector('[data-segment="blocked"]')).toBeTruthy();
    // 构成数字:为 0 的不显示。
    expect(rowOf("w-urgent").querySelector('[data-testid="work-counts"]')!.textContent).toBe("执行 1阻塞 1");
    view.unmount();
  });

  it("大卡自上而下:标题与补充、原因、在跑的任务、构成条与数字、最近有动静的任务", () => {
    const rows: TaskRow[] = [
      task("w-two", { title: "PLT-Honest：系统说的每句话必须为真" }),
      member("t-done", "w-two", { canonicalStatus: "done" }),
      member("t-run", "w-two", {
        title: "S7 授权执行：细节",
        canonicalStatus: "active",
        activeExecutionId: "exec-1",
        leaseHolder: "person_x · runtime-session:runtime_1",
        events: [{ at: "2026-02-01", taskId: "t-run", projectId: "p", summary: "Execution exec-1 started" }],
      }),
      member("t-wait", "w-two", {
        canonicalStatus: "blocked",
        blockers: [
          // 已经报了「等你」:同一条 awaits 边不在阻塞那一句里重复一遍。
          {
            relationId: "rel_0",
            kind: "awaits",
            sourceTaskId: "t-wait",
            personId: "zeyu",
            askKind: "acceptance",
            question: "看截图",
          },
          { relationId: "rel_1", kind: "depends-on", sourceTaskId: "t-wait", targetTaskId: "t-run" },
        ],
      }),
    ];
    const host = document.createElement("div"),
      root = createRoot(host),
      opened: string[] = [];
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
          agenda={
            {
              ...AGENDA,
              attentionItems: [
                attention("relation/r1", "awaiting-you", "mine", "w-two", 130, "验收两行：看截图"),
                attention("relation/r2", "decision", "mine", "w-two", 90, "另一件"),
              ],
            } as unknown as AgendaSuccess
          }
        />,
      ),
    );
    const card = host.querySelector('[data-testid="work-row"][data-work-id="w-two"]')!;
    expect(card.getAttribute("data-summary-card")).toBe("large");
    expect([...card.children].map((child) => child.getAttribute("data-testid") ?? child.tagName)).toEqual([
      "HEADER",
      "work-flags",
      "work-running",
      "work-progress",
      "work-counts",
      "work-recent",
    ]);
    // 标题止于冒号前,冒号后的补充在下一行弱色;整张卡只有标题这一个可点目标。
    expect(card.querySelector("header button")!.textContent).toBe("PLT-Honest");
    expect(card.querySelector("header p")!.textContent).toBe("系统说的每句话必须为真");
    expect(card.querySelectorAll("button")).toHaveLength(1);
    expect([...card.querySelectorAll('[data-testid="work-flags"] > p')].map((line) => line.textContent)).toEqual([
      "等你答复验收两行：看截图（另 1 件）",
      "有阻塞被「S7 授权执行」卡住",
    ]);
    // 在跑行只报个数与第一个在跑任务的标题,不出现执行者的机器标识。
    expect(card.querySelector('[data-testid="work-running"]')!.textContent).toBe("1 个 agent 在跑 · S7 授权执行");
    // 大卡上的构成条加粗。
    expect(card.querySelector('[data-testid="work-progress"] > div')!.className).toContain("h-[6px]!");
    expect(card.querySelector('[data-testid="work-progress"]')!.textContent).toBe("1/3");
    expect(card.querySelector('[data-testid="work-counts"]')!.textContent).toBe("完成 1执行 1阻塞 1");
    // 卡脚报最近有动静的任务的标题,不显示生命周期事件的机器摘要。
    expect(card.querySelector('[data-testid="work-recent"]')!.textContent).toBe("最近：S7 授权执行");
    expect(card.textContent).not.toContain("exec-1");
    expect(card.textContent).not.toContain("person_x");
    click(card.querySelector("header button")!);
    expect(opened).toEqual(["w-two"]);
    act(() => root.unmount());
  });

  it("最近有动静的任务不在本工作里(查不到标题)时,卡脚不出「最近」一行", () => {
    const host = document.createElement("div"),
      root = createRoot(host);
    act(() =>
      root.render(
        <WorkView
          tasks={[
            task("w-gone"),
            member("t-stuck", "w-gone", {
              canonicalStatus: "blocked",
              events: [{ at: "2026-02-01", taskId: "t-elsewhere", projectId: "p", summary: "Execution exec-9 closed" }],
            }),
          ]}
          repoId="p"
          ready
          onOpenTask={() => {}}
          catalog={undefined}
          catalogError={null}
          daemonState="responsive"
          onRefreshLedger={() => {}}
          agenda={AGENDA}
        />,
      ),
    );
    const card = host.querySelector('[data-testid="work-row"][data-work-id="w-gone"]')!;
    expect(card.getAttribute("data-summary-card")).toBe("large");
    expect(card.querySelector('[data-testid="work-recent"]')).toBeNull();
    expect(card.textContent).not.toContain("exec-9");
    act(() => root.unmount());
  });

  it("点卡片任意位置即打开工作", () => {
    const view = mountWorkView({ agenda: AGENDA });
    click(view.host.querySelector('[data-work-id="w-urgent"] [data-testid="work-progress"]')!);
    click(view.host.querySelector('[data-work-id="w-finished"]')!);
    expect(view.opened).toEqual(["w-urgent", "w-finished"]);
    view.unmount();
  });

  it("没有议程读面时仍按阻塞/停滞分出需要你看的组,不显示等你的原因", () => {
    const view = mountWorkView();
    expect(tierIds(view.host, "attention")).toEqual(["w-urgent", "w-stale"]);
    expect(tierIds(view.host, "progress")).toEqual(["w-running", "w-quiet"]);
    expect(view.host.querySelector('[data-testid="work-row"][data-work-id="w-urgent"]')?.textContent).not.toContain(
      "等你答复",
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
