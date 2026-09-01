import type { IDockviewPanelProps } from "dockview-react";
import { TerminalPane } from "./TerminalPane.tsx";
import { ErrorBoundary } from "../ErrorBoundary.tsx";
import { useTerminalPaneActions, type TerminalSplitDirection } from "./terminal-pane-context.ts";
import type { TerminalTab } from "../../terminal-model.ts";
import { t } from "../../i18n/index.tsx";

const warningClassName = [
  "border-b border-status-blocked/30 bg-status-blocked/10",
  "px-2 py-1 text-[11px] text-status-blocked",
].join(" ");

/**
 * 一个 split pane 的完整外观:自带 header(会话元信息 + 分割/关闭/终止)与 xterm 面板。
 *
 * dockview 的 group header 被隐藏(每个 group 恒定一个 panel,tab=group 的二级模型不允许
 * pane 再叠成第二层 tab),所以 pane 的标题栏由本组件自己画。载荷只认 params.sessionId:
 * 布局恢复后会话已消失时渲染可关闭占位,不阻塞其它 pane。
 */
export function TerminalPaneCard(props: IDockviewPanelProps<{ readonly sessionId: string }>) {
  const actions = useTerminalPaneActions();
  const panelId = props.api.id,
    sessionId = props.params.sessionId,
    tab = actions.session(sessionId),
    focused = actions.focusedPanelId === panelId;
  return (
    <div
      data-testid="terminal-pane-card"
      data-pane-id={panelId}
      data-session-id={sessionId}
      data-focused={focused ? "true" : "false"}
      onFocusCapture={() => actions.onFocusPane(panelId)}
      onMouseDownCapture={() => actions.onFocusPane(panelId)}
      className={[
        // dockview 的 panel 宿主(dv-react-part)是 block、非 flex,flex-1 在这里不生效,card 会缩到
        // 内容高、底下露黑。用 h-full 填满宿主高度,再由内部 flex-col 把终端撑到整个 pane。
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        focused ? "outline outline-1 -outline-offset-1 outline-accent/50" : "",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
        <span className="truncate font-mono text-text-faint">
          {tab ? `${tab.name} · ${tab.cwd} · ${tab.backend} · ${tab.durability} · ${tab.state}` : sessionId}
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <SplitButton panelId={panelId} direction="right" />
          <SplitButton panelId={panelId} direction="below" />
          <button
            onClick={() => actions.onClosePane(panelId, sessionId)}
            aria-label={t("terminal.view.closePaneAria", { name: tab?.name ?? sessionId })}
            title={t("terminal.view.closeDetachTitle")}
            className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
          >
            {t("terminal.view.closePane")}
          </button>
        </span>
        {tab && <TerminateControls tab={tab} />}
      </div>
      {tab ? <LivePane tab={tab} /> : <DeadPane panelId={panelId} sessionId={sessionId} />}
    </div>
  );
}

function LivePane({ tab }: { readonly tab: TerminalTab }) {
  const actions = useTerminalPaneActions();
  const interactive = tab.state === "running" && tab.attachable;
  return (
    <>
      {tab.warning && (
        <p role="status" className={warningClassName}>
          {tab.backend === "direct-pty"
            ? t("terminal.view.tmuxFallbackWarning")
            : t("terminal.view.tmuxUnavailableWarning")}
        </p>
      )}
      {tab.notice && (
        <p role="status" className={warningClassName}>
          {tab.notice}
        </p>
      )}
      {tab.state === "running" || tab.output ? (
        // pane 级错误边界:单个 pane 渲染抛错(如某个 addon/renderer)只在本 pane 兜底,
        // tab 条、其他 pane 与整窗都不受影响,不再一个 pane 崩溃就拖黑整个终端页。
        <ErrorBoundary>
          <TerminalPane
            output={tab.output}
            interactive={interactive}
            openUrl={actions.openUrl}
            onOpenLink={(match, text) => actions.openLink(match, text, tab.cwd)}
            onInput={(utf8) => actions.onInput(tab.sessionId, utf8)}
            onFit={(cols, rows) => actions.onFit(tab.sessionId, cols, rows)}
          />
        </ErrorBoundary>
      ) : (
        <div className="grid flex-1 place-items-center px-4 text-center text-[12px] text-text-faint">
          {tab.notice ?? t("terminal.view.sessionNotInteractive")}
        </div>
      )}
    </>
  );
}

/** 布局恢复后 daemon 侧已无对应会话:占位保留位置与关闭入口,不静默吞掉这个 pane。 */
function DeadPane({ panelId, sessionId }: { readonly panelId: string; readonly sessionId: string }) {
  const actions = useTerminalPaneActions();
  return (
    <div
      role="status"
      data-testid="terminal-pane-dead"
      className="grid flex-1 place-items-center gap-2 px-4 text-center text-[12px] text-text-faint"
    >
      <span>{t("terminal.view.paneSessionGone")}</span>
      <button
        onClick={() => actions.onClosePane(panelId, sessionId)}
        className="rounded border border-border px-2 py-1 text-text-muted hover:bg-surface-raised"
      >
        {t("terminal.view.closePane")}
      </button>
    </div>
  );
}

function SplitButton({ panelId, direction }: { readonly panelId: string; readonly direction: TerminalSplitDirection }) {
  const actions = useTerminalPaneActions();
  const label = direction === "right" ? t("terminal.view.splitRight") : t("terminal.view.splitDown");
  return (
    <button
      onClick={() => actions.onSplitPane(panelId, direction)}
      aria-label={label}
      title={label}
      className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
    >
      {direction === "right" ? "⇹" : "⇳"}
    </button>
  );
}

function TerminateControls({ tab }: { readonly tab: TerminalTab }) {
  const actions = useTerminalPaneActions();
  if (actions.confirmSessionId !== tab.sessionId)
    return (
      <button
        onClick={() => actions.setConfirmSessionId(tab.sessionId)}
        className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised"
      >
        {t("terminal.view.terminate")}
      </button>
    );
  return (
    <>
      <span className="text-status-blocked">{t("terminal.view.confirmTerminatePrompt")}</span>
      <button
        onClick={() => actions.setConfirmSessionId(null)}
        className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised"
      >
        {t("terminal.view.cancel")}
      </button>
      <button
        onClick={() => actions.onTerminate(tab.sessionId)}
        className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised"
      >
        {t("terminal.view.confirmTerminate")}
      </button>
    </>
  );
}
