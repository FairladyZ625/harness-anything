import { TerminalRoute } from "../../views/TerminalRoute.tsx";
import { BrowserView } from "../../views/BrowserView.tsx";
import type { WorkbenchPanelProps } from "../workbench-panels.tsx";

/**
 * 生命周期面板(终端/浏览器):资源语义与页面版完全一致——
 * 终端面板挂载即 attach、关闭面板 = 离开终端页(停流 + detach 全部附件,会话不删,
 * 重开面板重新列表并按需 attach);面板内不发起 terminate,删除会话仍走终端自身的
 * 显式确认。浏览器面板是独立 partition 的 webview,关闭即销毁该 webview 实例,
 * 重开按地址栏初始 URL 新建,不产生跨面板的第二份资源。
 * URL 出口(终端里点链接)走 App navigate 去浏览器页,离开工作台是显式动作。
 */

/** 终端面板:终端页同一 TerminalRoute 接线面;launchTask 无(面板不替用户建绑定会话)。 */
export function TerminalPanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-terminal-panel">
      <TerminalRoute
        repoId={props.repoId}
        daemonGeneration={props.daemonGeneration}
        repoRoot={props.repoRoot}
        tasks={props.tasks}
        launchTask={null}
        navigate={props.navigate}
        onNavigateEntity={props.onNavigateEntity}
        onOpenDocument={props.onOpenDocument}
      />
    </div>
  );
}

/** 浏览器面板:应用内浏览器页同一功能体(自带地址栏,webview 生命周期自管)。 */
export function BrowserPanel() {
  return (
    <div className="h-full min-h-0" data-testid="workbench-browser-panel">
      <BrowserView />
    </div>
  );
}
