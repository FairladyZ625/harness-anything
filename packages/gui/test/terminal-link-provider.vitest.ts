// harness-test-tier: fast
import { describe, expect, it, vi } from "vitest";
import {
  terminalLinksOnLine,
  type ScannableLine,
  type TerminalLinkItem,
} from "../src/renderer/components/terminal/terminal-link-provider.ts";
import { terminalLinkTargetOf } from "../src/renderer/components/terminal/terminal-links.ts";
import {
  createViewHistory,
  currentLocation,
  goBack,
  canGoBack,
  pushLocation,
  type AppLocation,
} from "../src/renderer/navigation/viewHistory.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";

/**
 * 伪造一行 buffer cell:parts 里每个字符串默认单宽逐字符占列;
 * [text, 2] 形态表示一个占两列的宽字符(首列带字符,后续列为空)。
 */
function fakeLine(parts: readonly (readonly [string, number?])[]): ScannableLine {
  const cells: string[] = [];
  for (const [text, width] of parts) {
    if (width === undefined || width === 1) for (const ch of text) cells.push(ch);
    else {
      cells.push(text);
      for (let extra = 1; extra < width; extra += 1) cells.push("");
    }
  }
  return {
    length: cells.length,
    getCell: (x: number) => (x >= 0 && x < cells.length ? { getChars: () => cells[x]! } : undefined),
  };
}

function linksOf(
  line: ScannableLine,
  onOpenLink: (match: unknown, text: string) => void = () => undefined,
): TerminalLinkItem[] {
  return terminalLinksOnLine(line, 7, onOpenLink as (match: never, text: string) => void);
}

describe("terminalLinksOnLine:buffer 行 → 链接", () => {
  it("maps match offsets to 1-based cell columns", () => {
    const links = linksOf(fakeLine([["  edit src/a.ts:12 ok"]]));
    expect(links).toHaveLength(1);
    expect(links[0]!.range).toEqual({ start: { x: 8, y: 7 }, end: { x: 18, y: 7 } });
    expect(links[0]!.text).toBe("src/a.ts:12");
  });

  it("keeps wide-char column occupancy before the link", () => {
    const links = linksOf(fakeLine([["终", 2], ["端", 2], [" packages/a.ts"]]));
    expect(links).toHaveLength(1);
    // 两个宽字符各占 2 列:链接起点在第 6 列(1 基),不是按字符数得出的第 4 列。
    expect(links[0]!.range.start.x).toBe(6);
    expect(links[0]!.text).toBe("packages/a.ts");
  });

  it("activates through the registered callback with the parsed match and source text", () => {
    const onOpenLink = vi.fn();
    const links = linksOf(fakeLine([["task_01cb8cf64ad28a48b4a7506b85 ok"]]), onOpenLink);
    expect(links).toHaveLength(1);
    links[0]!.activate({} as MouseEvent, "ignored");
    expect(onOpenLink).toHaveBeenCalledWith(
      { kind: "entity", ref: "task/01cb8cf64ad28a48b4a7506b85", start: 0, end: 31 },
      "task_01cb8cf64ad28a48b4a7506b85",
    );
  });

  it("returns an empty list for a line without links", () => {
    expect(linksOf(fakeLine([["all good, nothing here"]]))).toEqual([]);
  });
});

describe("点击可返回:实体链接落点经 viewHistory 推栈,回撤回终端页", () => {
  const terminalLocation: AppLocation = {
    view: "terminal",
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    taskFilters: DEFAULT_TASK_FILTERS,
    drill: null,
  };

  it("task 链接按 App 的 openTaskDetail 语义推栈(selectedId),goBack 回终端", () => {
    const links = linksOf(fakeLine([["opened task_01cb8cf64ad28a48b4a7506b85 now"]]));
    const target = terminalLinkTargetOf(links[0]!.match, { repoRoot: "/repo", cwd: null });
    expect(target).toEqual({ kind: "entity", ref: "task/01cb8cf64ad28a48b4a7506b85" });

    let state = createViewHistory(terminalLocation);
    // useViewHistory.navigate 的语义:字段合并进当前位置后推栈;task 详情走 selectedId。
    state = pushLocation(state, { ...terminalLocation, selectedId: "01cb8cf64ad28a48b4a7506b85" });
    expect(currentLocation(state).selectedId).toBe("01cb8cf64ad28a48b4a7506b85");
    state = goBack(state);
    expect(currentLocation(state)).toEqual(terminalLocation);
  });

  it("decision 链接推 decisionDetail 视图位置,goBack 回终端", () => {
    const links = linksOf(fakeLine([["per dec_60AF05D4F52CEFE347F2208791 done"]]));
    const target = terminalLinkTargetOf(links[0]!.match, { repoRoot: "/repo", cwd: null });
    expect(target).toEqual({ kind: "entity", ref: "decision/60AF05D4F52CEFE347F2208791" });

    let state = createViewHistory(terminalLocation);
    state = pushLocation(state, {
      view: "decisionDetail",
      selectedId: null,
      previewId: null,
      focusedEntityRef: "decision/60AF05D4F52CEFE347F2208791",
      taskFilters: DEFAULT_TASK_FILTERS,
      drill: null,
    });
    expect(canGoBack(state)).toBe(true);
    state = goBack(state);
    expect(currentLocation(state).view).toBe("terminal");
  });
});
