// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DaemonTailPane,
  observeWindowRange,
  OBSERVE_ROW_HEIGHT,
  OBSERVE_WINDOW_OVERSCAN,
} from "../src/renderer/components/observe/DaemonTailPane.tsx";
import {
  applyObserveTailPage,
  initialObserveTail,
  OBSERVE_FOLLOW_ROW_LIMIT,
} from "../src/renderer/daemon-observe-model.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 观察页无限回看 + 窗口化的性能与行为判据:
 *  - 数据面:契约页宽(64 行/页)连续翻 157 页装 10,000+ 行,history 方向一条不丢;
 *  - 渲染面:挂在 DOM 上的行数只随视口行数 + overscan 走,与累计加载行数无关;
 *    触顶翻页锚定(新增头部行 × 固定行高)后视口内容不跳;
 *  - 顶栏计数呈现「已加载 N 行 · 是否还有更早 · 是否追尾」,不再暗示总量封顶。
 * 耗时数字(happy-dom 下)是数量级证据:翻一页是毫秒级,不是整列表重渲的几十毫秒级。
 */

const REPO_ID = "window-probe",
  AT = "2026-09-04T00:00:00.000Z",
  PAGE_WIDTH = 64,
  /** 157 页 × 64 行 = 10,048 行,超过一切旧上限。 */
  TOTAL_ROWS = PAGE_WIDTH * 157;

function eventRow(revision: number, title: string) {
  return {
    schema: "task-event/v1",
    eventId: `ev-win-${revision}`,
    workspaceRevision: revision,
    opId: "op-win",
    type: "task_created",
    actor: { kind: "agent", id: "agent_win" },
    source: { channel: "cli" },
    occurredAt: AT,
    taskId: `task_${revision}`,
    payload: { task: { title } },
  };
}

function eventPage(
  revisions: readonly number[],
  title: string,
  done: boolean,
  direction: "history" | "follow" = "history",
): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "events",
    direction,
    status: "ready",
    items: revisions.map((revision) => eventRow(revision, title)) as never,
    historyCursor: direction === "history" ? { kind: "events", revision: Math.min(...revisions) } : null,
    liveCursor: { kind: "events", revision: Math.max(...revisions) },
    sourceCursor: { kind: "events", revision: Math.max(...revisions) },
    done,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

setActiveLocale("zh-CN");

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

/** 把滚动体固定成 600px 视口、240,000px 内容的假象(happy-dom 无布局,显式可读)。 */
function stubViewport(body: HTMLElement): void {
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, value: 240_000 },
    clientHeight: { configurable: true, value: 600 },
  });
}

async function mountPane(pages: {
  readonly latest: ObserveTailRead;
  readonly older?: ObserveTailRead;
}): Promise<HTMLElement> {
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(async (payload) => {
    if (payload.kind !== "events") throw new Error("unexpected kind");
    if (payload.direction === "history") return payload.cursor ? (pages.older ?? pages.latest) : pages.latest;
    return { ...pages.latest, direction: "follow", items: [], historyCursor: null, done: true };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(DaemonTailPane, {
        repoId: REPO_ID,
        kind: "events",
        onNavigateEntity: () => undefined,
      }),
    );
  });
  for (let settle = 0; settle < 3; settle += 1)
    await act(async () => {
      await Promise.resolve();
    });
  return container;
}

describe("窗口区间纯函数:DOM 行数上界与累计行数无关", () => {
  it("10,000 行、600px 视口:渲染区间 ≤ 视口行数 + 两侧 overscan", () => {
    const window = observeWindowRange({ total: 10_000, scrollTop: 0, viewportHeight: 600 });
    expect(window).toEqual({ start: 0, end: 49 });
    const maxSpan = Math.ceil(600 / OBSERVE_ROW_HEIGHT) + 2 * OBSERVE_WINDOW_OVERSCAN;
    for (const scrollTop of [0, 1_000, 100_000, 239_400]) {
      const span = observeWindowRange({ total: 10_000, scrollTop, viewportHeight: 600 });
      expect(span.end - span.start).toBeLessThanOrEqual(maxSpan + 1);
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(10_000);
    }
  });

  it("小列表整表可见,空列表返回空区间", () => {
    expect(observeWindowRange({ total: 3, scrollTop: 0, viewportHeight: 0 })).toEqual({ start: 0, end: 3 });
    expect(observeWindowRange({ total: 0, scrollTop: 120, viewportHeight: 600 })).toEqual({ start: 0, end: 0 });
  });
});

describe("数据面:契约页宽连续翻页装万行,history 方向不裁剪", () => {
  it("157 页 × 64 行全部保留,单页应用在毫秒级", () => {
    const started = performance.now();
    let state = initialObserveTail(),
      applied = 0,
      pageMs = 0;
    // 依次触顶翻更早的 64 行/页:revision 从 TOTAL_ROWS 往回退,直到 1。
    for (let top = TOTAL_ROWS; top > 0; top -= PAGE_WIDTH) {
      const from = Math.max(1, top - PAGE_WIDTH + 1),
        pageStarted = performance.now();
      state = applyObserveTailPage(state, eventPage(range(from, top), `row-${from}`, false));
      pageMs = Math.max(pageMs, performance.now() - pageStarted);
      applied += 1;
    }
    const elapsed = performance.now() - started;
    console.info(
      `[perf] data plane: ${applied} pages x ${PAGE_WIDTH} rows -> ${state.rows.length} rows` +
        ` | total ${elapsed.toFixed(1)}ms | slowest single page ${pageMs.toFixed(2)}ms`,
    );
    expect(applied).toBe(157);
    expect(state.rows).toHaveLength(TOTAL_ROWS);
    expect(state.rows.at(0)!.revision).toBe(1);
    expect(state.rows.at(-1)!.revision).toBe(TOTAL_ROWS);
    expect(elapsed).toBeLessThan(2_000);
    // 超过内存上限的 follow 增长仍受 OBSERVE_FOLLOW_ROW_LIMIT 约束(只丢最旧端)。
    const trimmed = applyObserveTailPage(
      state,
      eventPage(range(TOTAL_ROWS + 1, TOTAL_ROWS + 5_000), "follow-page", true, "follow"),
    );
    expect(trimmed.rows).toHaveLength(OBSERVE_FOLLOW_ROW_LIMIT);
  });
});

describe("渲染面:10,048 行挂载后 DOM 行数有界,触顶翻页锚定不跳", () => {
  const latest = eventPage(range(1, TOTAL_ROWS), "latest-row", false),
    older = eventPage(range(-PAGE_WIDTH + 1, 0), "OLDROW", true);

  it("挂载即贴底:10,048 行在快照里,DOM 只挂视口附近", async () => {
    const container = await mountPane({ latest, older }),
      body = container.querySelector('[data-testid="observe-body-events"]') as HTMLDivElement;
    stubViewport(body);
    const rendered = () =>
      container.querySelectorAll('[data-testid="observe-pane-events"] [data-testid="observe-row"]');
    expect(rendered().length).toBeGreaterThan(0);
    expect(rendered().length).toBeLessThanOrEqual(
      Math.ceil(600 / OBSERVE_ROW_HEIGHT) + 2 * OBSERVE_WINDOW_OVERSCAN + 1,
    );
    // 顶栏计数:已加载行数 + 还有更早 + 追尾中,不再出现「N / N 行」式封顶表述。
    const count = container.querySelector('[data-testid="observe-count-events"]')!.textContent!;
    expect(count).toContain(`已加载 ${TOTAL_ROWS} 行`);
    expect(count).toContain("上滚可加载更早");
    expect(count).toContain("追尾中");
  });

  it("触顶翻一页历史:按新增行 × 行高锚定,视口内容不跳,DOM 行数不涨", async () => {
    const container = await mountPane({ latest, older }),
      body = container.querySelector('[data-testid="observe-body-events"]') as HTMLDivElement;
    stubViewport(body);
    await act(async () => {
      body.scrollTop = 0;
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    // 触顶一页 64 行 × 24px = 1,536px:scrollTop 被锚定到新插入行之下,顶部内容仍可见。
    expect(body.scrollTop).toBe(PAGE_WIDTH * OBSERVE_ROW_HEIGHT);
    const rows = Array.from(
      container.querySelectorAll('[data-testid="observe-pane-events"] [data-testid="observe-row"]'),
      (row) => row.textContent!,
    );
    expect(rows.length).toBeLessThanOrEqual(Math.ceil(600 / OBSERVE_ROW_HEIGHT) + 2 * OBSERVE_WINDOW_OVERSCAN + 1);
    expect(rows[0]).toContain("OLDROW");
    // 翻到头(done: true)后计数切到「已到最早」,上滚后不再追尾。
    const count = container.querySelector('[data-testid="observe-count-events"]')!.textContent!;
    expect(count).toContain("已到最早");
    expect(count).toContain("浏览中");
    expect(container.querySelector('[data-testid="observe-jump-events"]')).not.toBeNull();
  });

  it("10,048 行下一次触顶翻页的渲染耗时在毫秒级(窗口化,非整列表重渲)", async () => {
    const container = await mountPane({ latest, older }),
      body = container.querySelector('[data-testid="observe-body-events"]') as HTMLDivElement;
    stubViewport(body);
    await act(async () => {
      body.scrollTop = 0;
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const started = performance.now();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    const flipMs = performance.now() - started,
      domRows = container.querySelectorAll('[data-testid="observe-pane-events"] [data-testid="observe-row"]').length,
      domNodes = (container.querySelector('[data-testid="observe-body-events"]') as HTMLElement).querySelectorAll(
        "*",
      ).length;
    console.info(
      `[perf] page flip: snapshot rows ${TOTAL_ROWS + PAGE_WIDTH} -> DOM rows ${domRows}` +
        ` (body descendant nodes ${domNodes}) | flip ${flipMs.toFixed(1)}ms`,
    );
    // 上界留宽裕(happy-dom + CI 抖动):窗口化下单页翻页应在个位数毫秒,断言 < 250ms
    // 防回归成 O(总行数)(整列表重渲 10k 行会显著超过它)。
    expect(flipMs).toBeLessThan(250);
    expect(domRows).toBeGreaterThan(0);
  });
});
