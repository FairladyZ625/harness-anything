/**
 * 焦点导航历史(REQ-GUI-01 + REQ-GUI-04):纯 reducer,稳定无自触发循环。
 *
 * 每次真实导航 PUSH 追加一项(去重当前位);BACK/FORWARD 只移动指针不追加;
 * BACK 后新 PUSH 截断 forward 分支。CLEAR 清空。
 */

export interface FocusHistoryState {
  /** 焦点 ref 栈(decision/<id>、task/<id> 等)。 */
  stack: string[];
  /** 当前指针(-1 = 无焦点)。 */
  index: number;
}

export type FocusHistoryAction =
  | { type: "push"; ref: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "clear" }
  | { type: "replace"; ref: string | null };

export const EMPTY_HISTORY: FocusHistoryState = { stack: [], index: -1 };

export function focusHistoryReducer(
  state: FocusHistoryState,
  action: FocusHistoryAction,
): FocusHistoryState {
  switch (action.type) {
    case "push": {
      if (state.stack[state.index] === action.ref) return state;
      const stack = state.stack.slice(0, state.index + 1);
      stack.push(action.ref);
      return { stack: stack.slice(-50), index: Math.min(stack.length - 1, 49) };
    }
    case "back": {
      if (state.index <= 0) return state;
      return { ...state, index: state.index - 1 };
    }
    case "forward": {
      if (state.index >= state.stack.length - 1) return state;
      return { ...state, index: state.index + 1 };
    }
    case "clear":
      return EMPTY_HISTORY;
    case "replace": {
      if (action.ref === null) return EMPTY_HISTORY;
      if (state.stack[state.index] === action.ref) return state;
      const stack = state.stack.slice(0, state.index + 1);
      stack.push(action.ref);
      return { stack: stack.slice(-50), index: Math.min(stack.length - 1, 49) };
    }
    default:
      return state;
  }
}

/** 当前焦点 ref(null = 无)。 */
export function currentFocus(state: FocusHistoryState): string | null {
  return state.index >= 0 ? state.stack[state.index] ?? null : null;
}

export function canBack(state: FocusHistoryState): boolean {
  return state.index > 0;
}

export function canForward(state: FocusHistoryState): boolean {
  return state.index < state.stack.length - 1;
}
