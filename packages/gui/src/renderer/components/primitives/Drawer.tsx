import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { isImeComposingEvent } from "./ime-composition.ts";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../../motion-tokens.ts";

/**
 * 右侧抽屉(标准 §4):实体详情的玻璃壳——定位、scrim、进出场、Esc 关闭。
 * 内容(生命周期进度、要做什么、做成了什么、关键记录、操作按钮、原始事件入口)
 * 由调用方组合;关闭按钮也归内容侧(头部归调用方,Esc 与点背景已覆盖壳层)。
 *
 * modal=false 为非模态:压暗层不接指针事件,点它下面的列表那一次点击直接生效
 * (实测:遮罩接事件时换一张卡要点两次);关闭判据为「主键按在抽屉外的惰性空白上」
 * ——压在交互控件上的按下归控件自己的激活,侧键 3/4 归 App 级前进/后退
 * (F-9280B707:任务预览的 onClose 是弹栈,抢先关闭会与控件自身的导航相互抵消/叠加)。
 */

/** 自身会被这次按下滑动的控件:那次按下由控件的激活语义接管,不构成「点外部关闭」。 */
const INTERACTIVE_PRESS_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='option']",
  "[role='menuitem']",
].join(",");

export function Drawer({
  open,
  onClose,
  ariaLabel,
  modal = true,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly ariaLabel?: string;
  readonly modal?: boolean;
  readonly children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  // 压暗层是纯 opacity:减弱动效下 motion 库只瞬时化位移/布局,opacity 仍按原时长播,
  // 必须显式接 reducedFade(§6 ≤120ms 纯淡入);偏好「关」时不播(与 Modal 同一契约)。
  // 面板滑入是 x 位移,库在减弱动效下自动瞬时,无需分支。
  const { enabled, reduced } = useEntryMotion();
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeComposingEvent(event)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || modal) return;
    const onPointerDown = (event: MouseEvent) => {
      // 侧键 3/4 是 App 级前进/后退的按下(useAppShortcuts),右/中键同样不是「点外部关闭」。
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target) === true) return;
      if (target instanceof Element && target.closest(INTERACTIVE_PRESS_SELECTOR) !== null) return;
      onClose();
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open, modal, onClose]);

  return (
    <AnimatePresence>
      {open && modal && (
        <motion.div
          key="drawer-scrim"
          className="glass-scrim fixed inset-0 z-10"
          initial={enabled ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          exit={enabled ? { opacity: 0 } : undefined}
          transition={{
            duration: reduced ? MOTION_DURATION.reducedFade : MOTION_DURATION.overlayRise,
            ease: MOTION_EASE.out,
          }}
          onClick={onClose}
        />
      )}
      {open && !modal && (
        <div
          data-testid="drawer-backdrop"
          className="pointer-events-none fixed inset-0 z-10 flex justify-end bg-bg/45"
        />
      )}
      {open && (
        <motion.aside
          key="drawer-panel"
          ref={panelRef}
          role="dialog"
          aria-modal={modal || undefined}
          aria-label={ariaLabel}
          className="glass glass-overlay pointer-events-auto fixed bottom-2.5 right-2.5 top-2.5 z-11 flex w-[min(500px,94vw)] flex-col gap-0 overflow-y-auto rounded-lg px-[18px] py-4"
          initial={{ x: "110%" }}
          animate={{ x: 0 }}
          exit={{ x: "110%" }}
          transition={{ duration: MOTION_DURATION.drawerSlide, ease: MOTION_EASE.panel }}
        >
          {children}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
