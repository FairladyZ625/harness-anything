import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * IME 组字守卫(标准 §1.10「规则住在原语里」):CJK 输入法组字(选词)期间,
 * 键盘事件属于输入法——Enter 只上屏候选,不触发确认/跳转/提交;方向键/Escape
 * 也归候选窗。keydown 与组字事件都会冒泡,本守卫挂在文本输入或其祖先上皆可。
 *
 * 三重判定各覆盖一类浏览器行为:
 *   - compositionstart/end 维护的组字会话状态:会话内所有 keydown 都放行;
 *   - nativeEvent.isComposing:Chromium 里提交组字的那次 Enter 也为真;
 *   - keyCode 229:WebKit 在 compositionend 之后才派发 keydown 的兜底。
 */
export function useImeKeyDown<T extends Element>(
  handler: (event: ReactKeyboardEvent<T>) => void,
): {
  readonly onKeyDown: (event: ReactKeyboardEvent<T>) => void;
  readonly compositionProps: {
    readonly onCompositionStart: () => void;
    readonly onCompositionEnd: () => void;
  };
} {
  const [composing, setComposing] = useState(false);
  return {
    onKeyDown(event) {
      if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
      handler(event);
    },
    compositionProps: {
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: () => setComposing(false),
    },
  };
}
