import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
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
const splitDirections: readonly TerminalSplitDirection[] = ["left", "right", "above", "below"];
/** 正在被拖的 pane;一个窗口同一时刻只有一场拖拽,不经 dataTransfer(happy-dom 里也能驱动)。 */
const drag: { panelId: string | null } = { panelId: null };
const dropZoneClassName: Record<TerminalSplitDirection, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  above: "inset-x-0 top-0 h-1/2",
  below: "inset-x-0 bottom-0 h-1/2",
};

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
  const [dropZone, setDropZone] = useState<TerminalSplitDirection | null>(null);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [selection, setSelection] = useState("");
  // 拖拽换位:标题栏是把手;别的 pane 的整张 card 是落点,按指针离哪条边最近分四个半区。
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!drag.panelId || drag.panelId === panelId) return;
    event.preventDefault();
    setDropZone(dropZoneOf(event, event.currentTarget));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const source = drag.panelId;
    setDropZone(null);
    if (!source || source === panelId) return;
    event.preventDefault();
    drag.panelId = null;
    actions.onMovePane(source, panelId, dropZoneOf(event, event.currentTarget));
  };
  return (
    <div
      data-testid="terminal-pane-card"
      data-pane-id={panelId}
      data-session-id={sessionId}
      data-focused={focused ? "true" : "false"}
      onFocusCapture={() => actions.onFocusPane(panelId)}
      onMouseDownCapture={() => actions.onFocusPane(panelId)}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropZone(null);
      }}
      onDrop={onDrop}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.onFocusPane(panelId);
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      className={[
        // dockview 的 panel 宿主(dv-react-part)是 block、非 flex,flex-1 在这里不生效,card 会缩到
        // 内容高、底下露黑。用 h-full 填满宿主高度,再由内部 flex-col 把终端撑到整个 pane。
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        focused ? "outline outline-1 -outline-offset-1 outline-accent/50" : "",
      ].join(" ")}
    >
      {dropZone && (
        <div
          data-testid="terminal-pane-drop"
          data-zone={dropZone}
          className={`pointer-events-none absolute z-10 border-2 border-accent bg-accent/20 ${
            dropZoneClassName[dropZone]
          }`}
        />
      )}
      {menu && (
        <PaneMenu
          at={menu}
          onClose={() => setMenu(null)}
          selection={selection}
          onPaste={tab?.state === "running" && tab.attachable ? (text) => actions.onInput(tab.sessionId, text) : null}
          onSplit={(direction) => actions.onSplitPane(panelId, direction)}
          onClosePane={() => actions.onClosePane(panelId, sessionId)}
          onTerminate={tab ? () => actions.setConfirmSessionId(tab.sessionId) : null}
        />
      )}
      <div
        draggable
        title={t("terminal.view.dragHandleTitle")}
        onDragStart={(event) => {
          drag.panelId = panelId;
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", panelId);
          }
        }}
        onDragEnd={() => {
          drag.panelId = null;
        }}
        className={
          "flex cursor-grab flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-[11px] " +
          "active:cursor-grabbing"
        }
      >
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
      {tab ? (
        <LivePane tab={tab} onSelectionChange={setSelection} />
      ) : (
        <DeadPane panelId={panelId} sessionId={sessionId} />
      )}
    </div>
  );
}

function LivePane({
  tab,
  onSelectionChange,
}: {
  readonly tab: TerminalTab;
  readonly onSelectionChange: (text: string) => void;
}) {
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
            outputBytes={tab.outputBytes}
            interactive={interactive}
            openUrl={actions.openUrl}
            onOpenLink={(match, text) => actions.openLink(match, text, tab.cwd)}
            onSelectionChange={onSelectionChange}
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

function splitLabel(direction: TerminalSplitDirection): string {
  switch (direction) {
    case "left":
      return t("terminal.view.splitLeft");
    case "right":
      return t("terminal.view.splitRight");
    case "above":
      return t("terminal.view.splitUp");
    case "below":
      return t("terminal.view.splitDown");
  }
}

/** 指针离 card 哪条边最近,就落到那一侧;card 无尺寸(测试环境)时默认落右侧。 */
function dropZoneOf(event: { readonly clientX: number; readonly clientY: number }, card: HTMLElement) {
  const rect = card.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return "right";
  const x = (event.clientX - rect.left) / rect.width,
    y = (event.clientY - rect.top) / rect.height;
  const edges: readonly (readonly [TerminalSplitDirection, number])[] = [
    ["left", x],
    ["right", 1 - x],
    ["above", y],
    ["below", 1 - y],
  ];
  return edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best))[0];
}

/** 右键菜单:portal 到 body 逃出 dockview 的 overflow 裁剪;点外面 / Esc / 选中任一项都关闭。 */
function PaneMenu({
  at,
  onClose,
  selection,
  onPaste,
  onSplit,
  onClosePane,
  onTerminate,
}: {
  readonly at: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
  readonly selection: string;
  readonly onPaste: ((text: string) => void) | null;
  readonly onSplit: (direction: TerminalSplitDirection) => void;
  readonly onClosePane: () => void;
  readonly onTerminate: (() => void) | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!ref.current?.contains(event.target as Node | null)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);
  const pick = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onClose();
    action();
  };
  const itemClassName = "block w-full rounded px-2 py-1 text-left text-text hover:bg-surface";
  const disabledItemClassName = [
    itemClassName,
    "disabled:cursor-not-allowed",
    "disabled:text-text-faint",
    "disabled:hover:bg-transparent",
  ].join(" ");
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t("terminal.view.paneMenuAria")}
      data-testid="terminal-pane-menu"
      style={{ left: at.x, top: at.y }}
      className="fixed z-50 min-w-40 rounded border border-border bg-surface-raised p-1 text-[12px] shadow-lg"
    >
      <button
        role="menuitem"
        disabled={!selection}
        onClick={pick(() => void navigator.clipboard.writeText(selection).catch(consumeKnownError))}
        className={disabledItemClassName}
      >
        {t("terminal.view.copy")}
      </button>
      <button
        role="menuitem"
        disabled={onPaste === null}
        onClick={pick(
          () =>
            void navigator.clipboard
              .readText()
              .then((text) => onPaste?.(text))
              .catch(consumeKnownError),
        )}
        className={disabledItemClassName}
      >
        {t("terminal.view.paste")}
      </button>
      {splitDirections.map((direction) => (
        <button key={direction} role="menuitem" onClick={pick(() => onSplit(direction))} className={itemClassName}>
          {splitLabel(direction)}
        </button>
      ))}
      <button role="menuitem" onClick={pick(onClosePane)} className={itemClassName}>
        {t("terminal.view.closePane")}
      </button>
      {onTerminate && (
        <button role="menuitem" onClick={pick(onTerminate)} className={`${itemClassName} text-status-blocked`}>
          {t("terminal.view.terminate")}
        </button>
      )}
    </div>,
    document.body,
  );
}

function consumeKnownError(error: unknown): void {
  void error;
}

function SplitButton({ panelId, direction }: { readonly panelId: string; readonly direction: TerminalSplitDirection }) {
  const actions = useTerminalPaneActions();
  const label = splitLabel(direction);
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
