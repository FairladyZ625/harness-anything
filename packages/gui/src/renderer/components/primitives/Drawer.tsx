import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * 右侧抽屉(标准 §4):实体详情的玻璃壳——定位、scrim、进出场、Esc 关闭。
 * 内容(生命周期进度、要做什么、做成了什么、关键记录、操作按钮、原始事件入口)
 * 由调用方组合;关闭按钮也归内容侧(头部归调用方,Esc 与点背景已覆盖壳层)。
 *
 * modal=false 为非模态:压暗层不接指针事件,点它下面的列表那一次点击直接生效
 * (实测:遮罩接事件时换一张卡要点两次);关闭判据为「按下位置不在抽屉里」。
 */
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
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || modal) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target) === true) return;
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
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
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
          className="glass pointer-events-auto fixed bottom-2.5 right-2.5 top-2.5 z-11 flex w-[min(500px,94vw)] flex-col gap-0 overflow-y-auto rounded-lg px-[18px] py-4"
          initial={{ x: "110%" }}
          animate={{ x: 0 }}
          exit={{ x: "110%" }}
          transition={{ duration: 0.38, ease: [0.2, 0.85, 0.25, 1] }}
        >
          {children}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
