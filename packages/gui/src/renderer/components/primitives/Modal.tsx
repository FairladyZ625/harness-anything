import { useLayoutEffect, useRef, type ReactNode } from "react";
import { animate, type AnimationPlaybackControls } from "motion";
import { t } from "../../i18n";
import { useEntryMotion } from "../../motion-config.tsx";

/** A3 弹窗进出动效(gui-visual-language-standard §6):进场 300ms 上浮淡入、退场
 * 180ms 下落淡出,均缓出曲线,时长落在布局类动画区间;减少动态效果只保留 100ms
 * 纯淡入、无位移;偏好「关」时不播,与今天一样瞬时。 */
export const MODAL_MOTION = {
  enterDistance: 10,
  enterDuration: 0.3,
  exitDistance: 6,
  exitDuration: 0.18,
  reducedDuration: 0.1,
} as const;

/**
 * 退场快照:全部 15 个调用点都是条件挂载({open && <Modal/>}),关闭即卸载,React
 * 不给组件延迟卸载的机会——卸载瞬间把压暗层与面板克隆到 body 的原几何位置播完
 * 退场再自移除。真实 DOM 立即卸载,原生 dialog 的焦点归还与 Esc 路径不受影响。
 */
function playExitSnapshot(options: {
  readonly panel: HTMLElement;
  readonly rect: DOMRect;
  readonly scrim: HTMLElement;
  readonly reduced: boolean;
}) {
  const { panel, rect, scrim, reduced } = options;
  const host = document.createElement("div");
  host.setAttribute("data-modal-exit-snapshot", "");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none;";
  const scrimClone = scrim.cloneNode(false) as HTMLElement;
  const shell = document.createElement("div");
  shell.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;`;
  const panelClone = panel.cloneNode(true) as HTMLElement;
  panelClone.style.margin = "0";
  shell.appendChild(panelClone);
  host.append(scrimClone, shell);
  document.body.appendChild(host);
  const duration = reduced ? MODAL_MOTION.reducedDuration : MODAL_MOTION.exitDuration;
  const controls: AnimationPlaybackControls[] = [
    animate(scrimClone, { opacity: [1, 0] }, { duration, ease: "easeOut" }),
    animate(panelClone, reduced ? { opacity: [1, 0] } : { opacity: [1, 0], y: [0, MODAL_MOTION.exitDistance] }, {
      duration,
      ease: "easeIn",
    }),
  ];
  // 动画被取消(窗口卸载等)时 finished 会拒绝;无论正常播完还是取消,快照都要移除。
  Promise.all(
    controls.map((control) =>
      control.finished.then(
        () => undefined,
        () => undefined,
      ),
    ),
  ).finally(() => host.remove());
}

export function Modal({
  title,
  hint,
  wide = false,
  testId,
  footer,
  onClose,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly wide?: boolean;
  readonly testId?: string;
  /** 未传时不渲染 footer 带;外壳 85dvh 限高,长内容在正文内滚动。 */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  /** 卸载时若 React 先移除节点再跑 cleanup,live rect 已归零,用每次渲染缓存的几何兜底。 */
  const geometry = useRef<DOMRect | null>(null);
  const motion = useEntryMotion();
  const motionRef = useRef(motion);
  useLayoutEffect(() => {
    motionRef.current = motion;
    if (panelRef.current) geometry.current = panelRef.current.getBoundingClientRect();
  });
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    dialog.showModal();
    const { enabled, reduced } = motionRef.current;
    const enterDuration = reduced ? MODAL_MOTION.reducedDuration : MODAL_MOTION.enterDuration;
    const controls: AnimationPlaybackControls[] = [];
    if (enabled && panel && scrim) {
      controls.push(
        animate(scrim, { opacity: [0, 1] }, { duration: enterDuration, ease: "easeOut" }),
        animate(panel, reduced ? { opacity: [0, 1] } : { opacity: [0, 1], y: [MODAL_MOTION.enterDistance, 0] }, {
          duration: enterDuration,
          ease: "easeOut",
        }),
      );
    }
    return () => {
      for (const control of controls) control.stop();
      const liveRect = panel?.getBoundingClientRect();
      const rect = liveRect && liveRect.height > 0 ? liveRect : geometry.current;
      dialog.close();
      // 偏好可能在弹窗开着时切换,退场读清理当下的状态,不读挂载时的闭包。
      const { enabled: exitEnabled, reduced: exitReduced } = motionRef.current;
      if (!exitEnabled || !panel || !scrim || !rect) return;
      // 真卸载时 React 在同一 commit 内移除节点,下一帧 dialog 已断开;StrictMode 的
      // 假卸载里节点仍连着,跳过快照避免给重新挂载的同一弹窗叠加退场残影。
      requestAnimationFrame(() => {
        if (dialog.isConnected) return;
        playExitSnapshot({ panel, rect, scrim, reduced: exitReduced });
      });
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      className="component-modal m-auto w-[calc(100%_-_3rem)] max-w-none border-0 bg-transparent p-0 text-text"
    >
      <div ref={scrimRef} aria-hidden="true" className="glass-scrim pointer-events-none fixed inset-0" />
      <div
        ref={panelRef}
        className={`glass mx-auto flex max-h-[var(--overlay-content-cap)] w-full flex-col overflow-hidden rounded-lg shadow-2xl ${wide ? "max-w-[760px]" : "max-w-[640px]"}`}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
          <b className="ui-body font-[650]">{title}</b>
          {hint && <span className="ui-micro text-text-faint">{hint}</span>}
          <button
            type="button"
            aria-label={t("components.primitives.close")}
            onClick={onClose}
            className="ml-auto min-h-[40px] min-w-[40px] px-1 ui-prose text-text-faint hover:text-text"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">{children}</div>
        {footer !== undefined && <footer className="shrink-0 border-t border-border px-3.5 py-2.5">{footer}</footer>}
      </div>
    </dialog>
  );
}
