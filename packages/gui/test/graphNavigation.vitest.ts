import { describe, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  createFocusHistory,
  currentFocus,
  goBack,
  goForward,
  pushFocus,
} from "../src/renderer/graph/focusHistory.ts";

/**
 * GraphView 焦点历史栈(dec_01KXA7811SVVT8P66HNDFZQ7DF — 关系图可用性)。
 *
 * 覆盖 push/truncate/back/forward/no-op 五条核心迁移;GraphView 的 back/forward
 * 按钮 + 面包屑依赖这些不变量。
 */

describe("focusHistory push", () => {
  it("starts empty with no current focus", () => {
    const state = createFocusHistory();
    expect(currentFocus(state)).toBeNull();
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(false);
  });

  it("pushes a focus id and exposes it as current", () => {
    const state = pushFocus(createFocusHistory(), "decision/dec_a");
    expect(currentFocus(state)).toBe("decision/dec_a");
    expect(state.entries).toEqual(["decision/dec_a"]);
    expect(state.index).toBe(0);
  });

  it("does not push the same id twice in a row (avoid stack flooding)", () => {
    const first = pushFocus(createFocusHistory(), "decision/dec_a");
    const second = pushFocus(first, "decision/dec_a");
    expect(second).toBe(first);
    expect(second.entries).toEqual(["decision/dec_a"]);
  });

  it("supports pushing distinct ids sequentially", () => {
    let state = createFocusHistory();
    state = pushFocus(state, "decision/dec_a");
    state = pushFocus(state, "decision/dec_b");
    state = pushFocus(state, "task/task_x");
    expect(state.entries).toEqual(["decision/dec_a", "decision/dec_b", "task/task_x"]);
    expect(state.index).toBe(2);
    expect(currentFocus(state)).toBe("task/task_x");
  });
});

describe("focusHistory forward truncation", () => {
  it("truncates the forward stack when pushing after going back", () => {
    let state = createFocusHistory();
    state = pushFocus(state, "decision/dec_a");
    state = pushFocus(state, "decision/dec_b");
    state = pushFocus(state, "decision/dec_c");
    state = goBack(state); // back to dec_b
    state = goBack(state); // back to dec_a
    expect(currentFocus(state)).toBe("decision/dec_a");
    expect(canGoForward(state)).toBe(true);

    state = pushFocus(state, "decision/dec_d");
    expect(state.entries).toEqual(["decision/dec_a", "decision/dec_d"]);
    expect(state.index).toBe(1);
    expect(canGoForward(state)).toBe(false);
  });
});

describe("focusHistory back/forward", () => {
  it("goBack is a no-op at the head of history", () => {
    const state = pushFocus(createFocusHistory(), "decision/dec_a");
    const back = goBack(state);
    expect(back).toBe(state);
  });

  it("goForward is a no-op at the tip of history", () => {
    const state = pushFocus(createFocusHistory(), "decision/dec_a");
    const forward = goForward(state);
    expect(forward).toBe(state);
  });

  it("moves back and forward through the stack deterministically", () => {
    let state = createFocusHistory();
    state = pushFocus(state, "decision/dec_a");
    state = pushFocus(state, "decision/dec_b");
    state = pushFocus(state, "decision/dec_c");

    state = goBack(state);
    expect(currentFocus(state)).toBe("decision/dec_b");
    state = goBack(state);
    expect(currentFocus(state)).toBe("decision/dec_a");

    state = goForward(state);
    expect(currentFocus(state)).toBe("decision/dec_b");
    state = goForward(state);
    expect(currentFocus(state)).toBe("decision/dec_c");
  });

  it("disables back at index 0 and forward at the tip", () => {
    let state = createFocusHistory();
    state = pushFocus(state, "decision/dec_a");
    state = pushFocus(state, "decision/dec_b");
    expect(canGoBack(state)).toBe(true);
    state = goBack(state);
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(true);
    state = goForward(state);
    expect(canGoForward(state)).toBe(false);
  });
});
