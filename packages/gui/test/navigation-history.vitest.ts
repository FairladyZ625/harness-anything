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
