// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import {
  focusHistoryReducer,
  EMPTY_HISTORY,
  currentFocus,
  canBack,
  canForward,
} from "../src/renderer/navigation/focusHistory.ts";

describe("navigation history reducer (HISTORY-001)", () => {
  it("starts empty with no focus", () => {
    expect(currentFocus(EMPTY_HISTORY)).toBeNull();
    expect(canBack(EMPTY_HISTORY)).toBe(false);
    expect(canForward(EMPTY_HISTORY)).toBe(false);
  });

  it("push appends exactly once for each unique navigation", () => {
    let state = EMPTY_HISTORY;
    state = focusHistoryReducer(state, { type: "push", ref: "decision/a" });
    expect(state.stack).toEqual(["decision/a"]);
    expect(state.index).toBe(0);

    // Pushing the SAME ref again → no duplicate.
    state = focusHistoryReducer(state, { type: "push", ref: "decision/a" });
    expect(state.stack).toEqual(["decision/a"]);
    expect(state.index).toBe(0);

    // Different ref → appended.
    state = focusHistoryReducer(state, { type: "push", ref: "decision/b" });
    expect(state.stack).toEqual(["decision/a", "decision/b"]);
    expect(state.index).toBe(1);
  });

  it("back/forward move pointer without appending", () => {
    let state = EMPTY_HISTORY;
    state = focusHistoryReducer(state, { type: "push", ref: "task/a" });
    state = focusHistoryReducer(state, { type: "push", ref: "task/b" });
    state = focusHistoryReducer(state, { type: "push", ref: "task/c" });
    expect(state.index).toBe(2);

    state = focusHistoryReducer(state, { type: "back" });
    expect(state.index).toBe(1);
    expect(currentFocus(state)).toBe("task/b");

    state = focusHistoryReducer(state, { type: "back" });
    expect(state.index).toBe(0);
    expect(currentFocus(state)).toBe("task/a");

    state = focusHistoryReducer(state, { type: "forward" });
    expect(state.index).toBe(1);
    expect(currentFocus(state)).toBe("task/b");
  });

  it("back then new push truncates forward branch", () => {
    let state = EMPTY_HISTORY;
    state = focusHistoryReducer(state, { type: "push", ref: "decision/a" });
    state = focusHistoryReducer(state, { type: "push", ref: "decision/b" });
    state = focusHistoryReducer(state, { type: "push", ref: "decision/c" });

    state = focusHistoryReducer(state, { type: "back" });
    state = focusHistoryReducer(state, { type: "back" });
    expect(state.index).toBe(0);
    expect(state.stack).toHaveLength(3); // forward branch still exists

    // New push truncates forward branch.
    state = focusHistoryReducer(state, { type: "push", ref: "decision/d" });
    expect(state.stack).toEqual(["decision/a", "decision/d"]);
    expect(state.index).toBe(1);
    expect(canForward(state)).toBe(false);
  });

  it("clear resets to empty", () => {
    let state = EMPTY_HISTORY;
    state = focusHistoryReducer(state, { type: "push", ref: "decision/a" });
    state = focusHistoryReducer(state, { type: "clear" });
    expect(state).toEqual(EMPTY_HISTORY);
    expect(currentFocus(state)).toBeNull();
  });

  it("does not self-trigger: same ref push is idempotent", () => {
    let state = EMPTY_HISTORY;
    state = focusHistoryReducer(state, { type: "push", ref: "decision/x" });
    const before = { ...state };
    // Simulate effect re-trigger with same ref.
    state = focusHistoryReducer(state, { type: "push", ref: "decision/x" });
    expect(state).toEqual(before);
  });

  it("back at index 0 is a no-op", () => {
    let state = EMPTY_HISTORY;
    state = focusHistoryReducer(state, { type: "push", ref: "decision/a" });
    state = focusHistoryReducer(state, { type: "back" });
    expect(state.index).toBe(0);
  });
});

// ---- 视图级后退/前进历史(REQ-GUI-01;移植老 main 线 navigationHistory) ----

import {
  createViewHistory,
  currentLocation,
  canGoBack as viewCanBack,
  canGoForward as viewCanForward,
  goBack as viewGoBack,
  goForward as viewGoForward,
  patchCurrent,
  pushLocation,
  type AppLocation,
} from "../src/renderer/navigation/viewHistory.ts";
import {
  initialLocation,
  readViewHistory,
  writeViewHistory,
  resetViewHistory,
} from "../src/renderer/navigation/viewHistoryStorage.ts";

function loc(patch: Partial<AppLocation>): AppLocation {
  return { ...initialLocation(), ...patch };
}

describe("view navigation history (HISTORY-002)", () => {
  it("pushes locations, truncates forward, and restores via back/forward", () => {
    let state = createViewHistory(loc({ view: "overview" }));
    state = pushLocation(state, loc({ view: "board", drill: { lane: "root-1", status: "active", groupBy: "root" } }));
    state = pushLocation(state, loc({ view: "graph", focusedEntityRef: "decision/dec_1" }));
    expect(viewCanBack(state)).toBe(true);
    state = viewGoBack(state);
    expect(currentLocation(state).view).toBe("board");
    expect(currentLocation(state).drill?.lane).toBe("root-1");
    // 从中间推新位置:forward 栈作废。
    state = pushLocation(state, loc({ view: "decisions" }));
    expect(viewCanForward(state)).toBe(false);
    state = viewGoBack(state);
    state = viewGoBack(state);
    expect(currentLocation(state).view).toBe("overview");
    expect(viewCanBack(state)).toBe(false);
    state = viewGoForward(state);
    expect(currentLocation(state).view).toBe("board");
  });

  it("patchCurrent updates in place without pushing a stack entry", () => {
    let state = createViewHistory(loc({ view: "board" }));
    state = patchCurrent(state, { taskFilters: { ...currentLocation(state).taskFilters, query: "x" } });
    expect(state.entries).toHaveLength(1);
    expect(currentLocation(state).taskFilters.query).toBe("x");
  });

  it("persists per project and rejects corrupted storage", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
    let state = createViewHistory(loc({ view: "board" }));
    state = pushLocation(state, loc({ view: "graph" }));
    writeViewHistory(shim, "proj-a", state);
    const restored = readViewHistory(shim, "proj-a");
    expect(currentLocation(restored).view).toBe("graph");
    expect(viewCanBack(restored)).toBe(true);
    // 其他项目互不污染。
    expect(currentLocation(readViewHistory(shim, "proj-b")).view).toBe("overview");
    // 坏存储回退干净初始栈。
    storage.set("harness-view-history:proj-c", "{not json");
    expect(viewCanBack(readViewHistory(shim, "proj-c"))).toBe(false);
    // 篡改后的栈(schema 头伪造)同样回退。
    storage.set("harness-view-history:proj-d", JSON.stringify({ schema: "gui-view-history/v1", history: { entries: [{ view: "rm -rf", selectedId: null, previewId: null, focusedEntityRef: null, taskFilters: initialLocation().taskFilters, drill: null }], index: 0 } }));
    expect(currentLocation(readViewHistory(shim, "proj-d")).view).toBe("overview");
    resetViewHistory(shim, "proj-a");
    expect(currentLocation(readViewHistory(shim, "proj-a")).view).toBe("overview");
  });
});
