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
  closePreview,
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
  handoffViewHistory,
  initialLocation,
  readViewHistory,
  writeViewHistory,
} from "../src/renderer/navigation/viewHistoryStorage.ts";

/** 两级介质各一个 shim:session 模拟本窗会话(可枚举),local 模拟跨重启兜底。 */
function makeLocal() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    raw: store,
  };
}
function makeSession() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    get length() {
      return store.size;
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    raw: store,
  };
}

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
    state = pushLocation(state, loc({ view: "freshness" }));
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

  it("persists the schedules view and narrows unknown stored view ids", () => {
    const session = makeSession();
    const local = makeLocal();
    // Reload closure: schedule focus survives through the window's session stack.
    let state = createViewHistory(loc({ view: "overview" }));
    state = pushLocation(state, loc({ view: "schedules", focusedEntityRef: "schedule/heartbeat-probe" }));
    writeViewHistory(session, "proj-schedules", state);
    const restored = readViewHistory(session, local, "proj-schedules");
    expect(currentLocation(restored).view).toBe("schedules");
    expect(currentLocation(restored).focusedEntityRef).toBe("schedule/heartbeat-probe");
    expect(viewCanBack(restored)).toBe(true);
    // Narrowing closure: a stored view id that is not in the closed ViewId set falls
    // back to the clean initial stack instead of rendering an unknown view.
    local.raw.set(
      "harness-view-history:proj-stale",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: {
          entries: [
            {
              view: "workbench",
              selectedId: null,
              previewId: null,
              focusedEntityRef: null,
              taskFilters: initialLocation().taskFilters,
              drill: null,
            },
          ],
          index: 0,
        },
      }),
    );
    expect(currentLocation(readViewHistory(session, local, "proj-stale")).view).toBe("overview");
    expect(viewCanBack(readViewHistory(session, local, "proj-stale"))).toBe(false);
  });

  it("persists the terminal first-class view and returns to the previous view on back", () => {
    const session = makeSession();
    const local = makeLocal();
    // W0:Ctrl+` 压栈进入终端页;离开走 goBack 回上一视图,位置经会话栈复原。
    let state = createViewHistory(loc({ view: "overview" }));
    state = pushLocation(state, loc({ view: "terminal" }));
    writeViewHistory(session, "proj-terminal", state);
    const restored = readViewHistory(session, local, "proj-terminal");
    expect(currentLocation(restored).view).toBe("terminal");
    expect(viewCanBack(restored)).toBe(true);
    state = viewGoBack(restored);
    expect(currentLocation(state).view).toBe("overview");
  });

  it("loads a stored stack that predates the removed module grouping, dropping only the module bits", () => {
    const session = makeSession();
    const local = makeLocal();
    const legacyFilters = { ...initialLocation().taskFilters, query: "keep-me", module: "gui" };
    local.raw.set(
      "harness-view-history:proj-legacy",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: {
          entries: [
            { ...initialLocation(), view: "board", taskFilters: legacyFilters, drill: null },
            {
              ...initialLocation(),
              view: "board",
              taskFilters: legacyFilters,
              drill: { lane: "gui", status: "active", groupBy: "module" },
            },
            {
              ...initialLocation(),
              view: "board",
              taskFilters: legacyFilters,
              drill: { lane: "root-1", status: "active", groupBy: "root" },
            },
          ],
          index: 2,
        },
      }),
    );
    const restored = readViewHistory(session, local, "proj-legacy");
    expect(restored.entries).toHaveLength(3);
    expect(restored.index).toBe(2);
    for (const entry of restored.entries) {
      expect(entry.view).toBe("board");
      expect(entry.taskFilters.query).toBe("keep-me");
      expect(entry.taskFilters).not.toHaveProperty("module");
    }
    // 按已删除的 module 维度下钻的 drill 丢成 null;现存维度的 drill 原样保留。
    expect(restored.entries[1]!.drill).toBeNull();
    expect(currentLocation(restored).drill).toEqual({ lane: "root-1", status: "active", groupBy: "root" });
    // 未知的 groupBy 仍然按坏存储回退干净初始栈。
    local.raw.set(
      "harness-view-history:proj-bad-drill",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: {
          entries: [{ ...initialLocation(), drill: { lane: "x", status: "active", groupBy: "planet" } }],
          index: 0,
        },
      }),
    );
    expect(currentLocation(readViewHistory(session, local, "proj-bad-drill")).view).toBe("overview");
  });

  it("persists per project and rejects corrupted storage", () => {
    const session = makeSession();
    const local = makeLocal();
    let state = createViewHistory(loc({ view: "board" }));
    state = pushLocation(state, loc({ view: "graph" }));
    writeViewHistory(session, "proj-a", state);
    const restored = readViewHistory(session, local, "proj-a");
    expect(currentLocation(restored).view).toBe("graph");
    expect(viewCanBack(restored)).toBe(true);
    // 其他项目互不污染。
    expect(currentLocation(readViewHistory(session, local, "proj-b")).view).toBe("overview");
    // 坏存储回退干净初始栈。
    local.raw.set("harness-view-history:proj-c", "{not json");
    expect(viewCanBack(readViewHistory(session, local, "proj-c"))).toBe(false);
    // 篡改后的栈(schema 头伪造)同样回退。
    local.raw.set(
      "harness-view-history:proj-d",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: {
          entries: [
            {
              view: "rm -rf",
              selectedId: null,
              previewId: null,
              focusedEntityRef: null,
              taskFilters: initialLocation().taskFilters,
              drill: null,
            },
          ],
          index: 0,
        },
      }),
    );
    expect(currentLocation(readViewHistory(session, local, "proj-d")).view).toBe("overview");
  });

  it("strips the retired overview in-page layer fields from stored history", () => {
    // 2026-10-21 总览四块重构撤销页内层(产物二级页/放大层):旧存储带着这些字段的
    // 条目仍可读,还原时就地剥除,不让已死字段在读写间轮回。
    const session = makeSession();
    const local = makeLocal();
    local.raw.set(
      "harness-view-history:proj-stale-layers",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: {
          entries: [
            {
              ...initialLocation(),
              overviewArtifactId: "task_a/artifacts/reports/r-0.html",
              overviewFocus: { key: "review", selectedId: "task_w1" },
            },
          ],
          index: 0,
        },
      }),
    );
    const restored = currentLocation(readViewHistory(session, local, "proj-stale-layers"));
    expect(restored.view).toBe("overview");
    expect((restored as Record<string, unknown>).overviewArtifactId).toBeUndefined();
    expect((restored as Record<string, unknown>).overviewFocus).toBeUndefined();
  });
});

describe("两级介质:同项目双窗口互不覆盖(task_48399f09c1673b4be25faed452)", () => {
  it("运行期写只落本窗会话,不动 localStorage;读序会话优先", () => {
    const session = makeSession();
    const local = makeLocal();
    let state = createViewHistory(loc({ view: "overview" }));
    state = pushLocation(state, loc({ view: "board" }));
    writeViewHistory(session, "proj-a", state);
    expect(local.raw.has("harness-view-history:proj-a")).toBe(false);
    // 他窗留在 localStorage 的栈不会进入本窗读结果:会话优先。
    local.raw.set(
      "harness-view-history:proj-a",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: { entries: [initialLocation(), { ...initialLocation(), view: "graph" }], index: 1 },
      }),
    );
    expect(currentLocation(readViewHistory(session, local, "proj-a")).view).toBe("board");
    // 重开窗口(会话为空)才从 localStorage 兜底恢复他窗/上次关闭的栈。
    expect(currentLocation(readViewHistory(makeSession(), local, "proj-a")).view).toBe("graph");
  });

  it("会话里的坏存储退到 localStorage 兜底;两级都坏才落干净初始栈", () => {
    const session = makeSession();
    const local = makeLocal();
    session.raw.set("harness-view-history:proj-a", "{not json");
    local.raw.set(
      "harness-view-history:proj-a",
      JSON.stringify({
        schema: "gui-view-history/v1",
        history: { entries: [initialLocation(), { ...initialLocation(), view: "agenda" }], index: 1 },
      }),
    );
    expect(currentLocation(readViewHistory(session, local, "proj-a")).view).toBe("agenda");
    local.raw.set("harness-view-history:proj-a", "{also not json");
    expect(currentLocation(readViewHistory(session, local, "proj-a")).view).toBe("overview");
    expect(viewCanBack(readViewHistory(session, local, "proj-a"))).toBe(false);
  });

  it("关闭写回:只复制本窗会话里的历史键,后关闭者覆盖先关闭者", () => {
    const windowA = makeSession();
    const windowB = makeSession();
    const local = makeLocal();
    let stateA = createViewHistory(loc({ view: "overview" }));
    stateA = pushLocation(stateA, loc({ view: "board" }));
    writeViewHistory(windowA, "proj-a", stateA);
    let stateB = createViewHistory(loc({ view: "overview" }));
    stateB = pushLocation(stateB, loc({ view: "graph" }));
    writeViewHistory(windowB, "proj-a", stateB);
    // 会话里可能有别的键(其他偏好共用 sessionStorage):不带前缀的不动。
    windowA.setItem("unrelated-pref", "keep");
    windowA.setItem("harness-view-history:proj-other", JSON.stringify({ untouched: true }));
    // A 先关,B 后关:localStorage 最终是 B 的栈(最后关闭的同项目窗口)。
    handoffViewHistory(windowA, local);
    expect(currentLocation(readViewHistory(makeSession(), local, "proj-a")).view).toBe("board");
    handoffViewHistory(windowB, local);
    expect(currentLocation(readViewHistory(makeSession(), local, "proj-a")).view).toBe("graph");
    expect(local.raw.get("unrelated-pref")).toBeUndefined();
    expect(currentLocation(readViewHistory(makeSession(), local, "proj-other")).view).toBe("overview");
  });
});

describe("preview drawer close (HISTORY-003, 业主 2026-10-17 单抽屉)", () => {
  it("pops the single drawer entry back to the list in one close", () => {
    // 新语义下连点换卡走 patchCurrent,一层只占一条:普通 goBack 即回列表。
    let state = createViewHistory(loc({ view: "board" }));
    state = pushLocation(state, loc({ view: "board", previewId: "t1" }));
    state = patchCurrent(state, { previewId: "t3" });
    state = closePreview(state);
    expect(currentLocation(state).view).toBe("board");
    expect(currentLocation(state).previewId).toBeNull();
    expect(viewCanBack(state)).toBe(false);
  });

  it("collapses consecutive legacy preview entries without replaying them", () => {
    // 旧代码逐次推栈攒下的连续预览条目同属一层:一次关闭越过整段,直回列表。
    let state = createViewHistory(loc({ view: "board" }));
    state = pushLocation(state, loc({ view: "board", previewId: "t1" }));
    state = pushLocation(state, loc({ view: "board", previewId: "t2" }));
    state = closePreview(state);
    expect(currentLocation(state).view).toBe("board");
    expect(currentLocation(state).previewId).toBeNull();
    // 中间预览不在后退可达范围里:条目还躺在 forward 分支,但指针已越过整段。
    expect(viewCanForward(state)).toBe(true);
    expect(currentLocation(viewGoForward(state)).previewId).toBe("t1");
  });

  it("keeps the position below the drawer when it is not a preview", () => {
    // 抽屉下方压着详情页时,关闭只弹预览这一层,回详情页。
    let state = createViewHistory(loc({ view: "board" }));
    state = pushLocation(state, loc({ view: "board", selectedId: "t9" }));
    state = pushLocation(state, loc({ view: "board", previewId: "t1" }));
    state = closePreview(state);
    expect(currentLocation(state).selectedId).toBe("t9");
    expect(currentLocation(state).previewId).toBeNull();
  });

  it("clears an orphan bottom drawer entry in place and is a no-op when the drawer is closed", () => {
    // 栈底恢复的孤立抽屉条目无处可退:原地清 previewId。
    let orphan = createViewHistory(loc({ view: "board", previewId: "t1" }));
    orphan = closePreview(orphan);
    expect(orphan.entries).toHaveLength(1);
    expect(currentLocation(orphan).previewId).toBeNull();
    // 抽屉关着时调用是 no-op,不吃历史条目。
    let closed = createViewHistory(loc({ view: "board" }));
    closed = pushLocation(closed, loc({ view: "graph" }));
    expect(closePreview(closed)).toBe(closed);
  });
});
