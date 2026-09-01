import { createContext, useContext } from "react";
import type { TerminalTab } from "../../terminal-model.ts";
import type { TerminalLinkMatch } from "./terminal-links.ts";

/** 分割方向:right = 竖直分隔条(左右并排),below = 水平分隔条(上下叠放)。 */
export type TerminalSplitDirection = "right" | "below";

/**
 * pane 载荷与动作的注入面(PLT-TerminalWorkspace W1)。
 *
 * dockview 的 panel 由 dockview 自己的 DOM 宿主渲染,但 dockview-react 用 portal 把
 * React 元素挂回调用方的树,因此 context 照常穿透:pane 组件只拿 sessionId,会话状态
 * 与全部副作用都从这里取,W0 的会话状态机(terminal-model / terminal-client)不下沉。
 */
export interface TerminalPaneActions {
  readonly session: (sessionId: string) => TerminalTab | null;
  readonly focusedPanelId: string | null;
  readonly confirmSessionId: string | null;
  readonly setConfirmSessionId: (sessionId: string | null) => void;
  readonly onInput: (sessionId: string, utf8: string) => void;
  readonly onFit: (sessionId: string, cols: number, rows: number) => void;
  readonly onFocusPane: (panelId: string) => void;
  readonly onClosePane: (panelId: string, sessionId: string) => void;
  readonly onSplitPane: (panelId: string, direction: TerminalSplitDirection) => void;
  readonly onTerminate: (sessionId: string) => void;
  /** W2 链接分发:match/text 来自 provider,cwd 是本 pane 会话的 daemon 侧工作目录。 */
  readonly openLink: (match: TerminalLinkMatch, text: string, cwd: string | null) => void;
  /** URL 打开接缝(W3 浏览器视图接线点);null = 面板用 web-links 默认行为(新窗口)。 */
  readonly openUrl: ((uri: string) => void) | null;
}

export const TerminalPaneContext = createContext<TerminalPaneActions | null>(null);

export function useTerminalPaneActions(): TerminalPaneActions {
  const value = useContext(TerminalPaneContext);
  if (!value) throw new Error("TerminalPaneContext is missing; render panes inside TerminalSplitGrid.");
  return value;
}
