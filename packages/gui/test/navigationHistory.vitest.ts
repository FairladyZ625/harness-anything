import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canGoBack,
  canGoForward,
  createNavigationHistory,
  currentLocation,
  goBack,
  goForward,
  locationsEqual,
  patchCurrent,
  pushLocation,
  type AppLocation,
} from "../src/renderer/navigation/navigationHistory.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";

/**
 * AppShell 全局导航历史栈测试。
 *
 * 两组覆盖:
 * 1. 纯函数:push / back / forward / truncate / dedup / patchCurrent —
 *    泛化自 graphNavigation.vitest.ts,语义不变,只是条目从 string 变成 AppLocation。
 * 2. 源码不变量:App.tsx 不得重新引入直接的位置-state setter(所有导航必须走
 *    navigate / updateLocation)。这是「所有导航都进历史栈」的机械保护——下一个
 *    改 App.tsx 的人如果偷偷加回 setView(...) 等,本测试会拦住。
 */

function location(overrides: Partial<AppLocation> = {}): AppLocation {
  return {
    view: "overview",
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    taskFilters: DEFAULT_TASK_FILTERS,
    drill: null,
    ...overrides,
  };
}

describe("navigationHistory create + current", () => {
  it("seeds history with the initial location at index 0", () => {
    const initial = location({ view: "board" });
    const state = createNavigationHistory(initial);
    expect(state.entries).toHaveLength(1);
    expect(state.index).toBe(0);
    expect(currentLocation(state)).toEqual(initial);
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(false);
  });
});

describe("navigationHistory push", () => {
  it("pushes a new location and advances the index", () => {
    const state = createNavigationHistory(location());
    const next = pushLocation(state, location({ view: "board" }));
    expect(next.entries).toHaveLength(2);
    expect(next.index).toBe(1);
    expect(currentLocation(next).view).toBe("board");
  });

  it("does not push an equivalent location (dedup)", () => {
    const initial = location({ view: "board", selectedId: "task-1" });
    const state = createNavigationHistory(initial);
    const same = pushLocation(state, location({ view: "board", selectedId: "task-1" }));
    expect(same).toBe(state);
    expect(same.entries).toHaveLength(1);
  });

  it("pushes when any field differs (view, selectedId, focusedEntityRef, drill)", () => {
    const state = createNavigationHistory(location({ view: "overview" }));

    expect(pushLocation(state, location({ view: "board" })).entries).toHaveLength(2);
    expect(
      pushLocation(state, location({ selectedId: "task-1" })).entries,
    ).toHaveLength(2);
    expect(
      pushLocation(state, location({ focusedEntityRef: "decision/d1" })).entries,
    ).toHaveLength(2);
  });

  it("detects taskFilters differences structurally (not by reference)", () => {
    const state = createNavigationHistory(location());
    const changedFilters = {
      ...DEFAULT_TASK_FILTERS,
      query: "blocking",
    };
    const next = pushLocation(state, location({ taskFilters: changedFilters }));
    expect(next.entries).toHaveLength(2);
    expect(currentLocation(next).taskFilters.query).toBe("blocking");
  });

  it("detects drill differences structurally", () => {
    const state = createNavigationHistory(location());
    const withDrill = pushLocation(state, location({
      view: "board",
      drill: { lane: "root", status: "blocked", groupBy: "root" as const },
    }));
    expect(withDrill.entries).toHaveLength(2);
    expect(currentLocation(withDrill).drill).toEqual({
      lane: "root",
      status: "blocked",
      groupBy: "root",
    });
  });
});

describe("navigationHistory forward truncation", () => {
  it("truncates the forward stack when pushing after going back", () => {
    let state = createNavigationHistory(location({ view: "overview" }));
    state = pushLocation(state, location({ view: "board" }));
    state = pushLocation(state, location({ view: "graph" }));
    expect(state.entries.map((e) => e.view)).toEqual(["overview", "board", "graph"]);

    state = goBack(state); // board
    state = goBack(state); // overview
    expect(currentLocation(state).view).toBe("overview");
    expect(canGoForward(state)).toBe(true);

    state = pushLocation(state, location({ view: "decisions" }));
    expect(state.entries.map((e) => e.view)).toEqual(["overview", "decisions"]);
    expect(state.index).toBe(1);
    expect(canGoForward(state)).toBe(false);
  });
});

describe("navigationHistory back/forward", () => {
  it("goBack is a no-op at the head of history", () => {
    const state = createNavigationHistory(location());
    expect(goBack(state)).toBe(state);
  });

  it("goForward is a no-op at the tip of history", () => {
    const state = createNavigationHistory(location());
    expect(goForward(state)).toBe(state);
  });

  it("moves back and forward through the stack", () => {
    let state = createNavigationHistory(location({ view: "overview" }));
    state = pushLocation(state, location({ view: "board", selectedId: "t1" }));
    state = pushLocation(state, location({ view: "graph", focusedEntityRef: "task/t1" }));

    state = goBack(state);
    expect(currentLocation(state).view).toBe("board");
    expect(currentLocation(state).selectedId).toBe("t1");
    state = goBack(state);
    expect(currentLocation(state).view).toBe("overview");
    expect(currentLocation(state).selectedId).toBeNull();

    state = goForward(state);
    expect(currentLocation(state).view).toBe("board");
    state = goForward(state);
    expect(currentLocation(state).view).toBe("graph");
    expect(currentLocation(state).focusedEntityRef).toBe("task/t1");
  });
});

describe("navigationHistory patchCurrent", () => {
  it("updates the current entry in place without pushing", () => {
    const state = createNavigationHistory(location({ view: "board" }));
    const patched = patchCurrent(state, { taskFilters: { ...DEFAULT_TASK_FILTERS, query: "x" } });
    expect(patched.entries).toHaveLength(1);
    expect(currentLocation(patched).taskFilters.query).toBe("x");
  });

  it("is a no-op when the patch produces an equivalent location", () => {
    const state = createNavigationHistory(location({ view: "board" }));
    expect(patchCurrent(state, { view: "board" })).toBe(state);
  });

  it("preserves forward stack (does not truncate)", () => {
    let state = createNavigationHistory(location({ view: "overview" }));
    state = pushLocation(state, location({ view: "board" }));
    state = goBack(state); // at overview, board is forward
    const patched = patchCurrent(state, { selectedId: "t1" });
    expect(patched.entries).toHaveLength(2);
    expect(canGoForward(patched)).toBe(true);
    expect(currentLocation(patched).selectedId).toBe("t1");
  });
});

describe("navigationHistory locationsEqual", () => {
  it("returns true for deeply equal locations", () => {
    const a = location({ view: "board", drill: { lane: "root", status: "blocked", groupBy: "root" as const } });
    const b = location({ view: "board", drill: { lane: "root", status: "blocked", groupBy: "root" as const } });
    expect(locationsEqual(a, b)).toBe(true);
  });

  it("returns false when taskFilters content differs", () => {
    const a = location({ taskFilters: { ...DEFAULT_TASK_FILTERS, query: "a" } });
    const b = location({ taskFilters: { ...DEFAULT_TASK_FILTERS, query: "b" } });
    expect(locationsEqual(a, b)).toBe(false);
  });
});

// ── 源码不变量:所有导航入口必须汇流到 navigate() ──────────────────
// App.tsx 曾经有六个并排的 useState 构成「应用位置」,其中四个导航入口绕过了
// goto 直接改 state,历史栈会漏记。重构后位置状态由 useNavigationHistory 持有,
// 变更只走 navigate / updateLocation。如果下一个改 App.tsx 的人加回了直接 setter,
// 本测试拦住——这是 N1 唯一真正的不变量。
describe("App.tsx navigation funnel invariant", () => {
  const appSource = readFileSync(
    path.resolve(import.meta.dirname, "../src/renderer/App.tsx"),
    "utf-8",
  );

  const BANNED_SETTERS = [
    "setView(",
    "setSelectedId(",
    "setPreviewId(",
    "setFocusedEntityRef(",
    "setDrill(",
    "setTaskFilters(",
  ];

  it("does not reintroduce direct location-state setters", () => {
    const offenders = BANNED_SETTERS.filter((token) => appSource.includes(token));
    expect(offenders).toEqual([]);
  });

  it("routes location changes through navigate() and updateLocation()", () => {
    expect(appSource).toContain("navigate(");
    expect(appSource).toContain("updateLocation(");
    expect(appSource).toContain("useNavigationHistory(");
  });
});
