import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { t } from "../../i18n";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../../motion-tokens.ts";
import { Button } from "./Button.tsx";

/** A3 弹窗进出动效(gui-visual-language-standard §6;dec_AEE443D93D207C4AEB032E7881 CH2):
 * 进场 300ms 上浮淡入、退场 180ms 下落淡出,均缓出曲线;减少动态效果只保留 100ms
 * 纯淡入淡出、无位移;偏好「关」时不播,瞬时进出。时长与缓动取自动效 token。 */
/** 位移量(px)是形状参数,不进 token。 */
const ENTER_DISTANCE = 10;
const EXIT_DISTANCE = 6;

type ModalSurfaceProps = {
  readonly title: string;
  readonly hint?: string;
  readonly wide?: boolean;
  readonly testId?: string;
  /** 未传时不渲染 footer 带;外壳 85dvh 限高,长内容在正文内滚动。 */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
};

/**
 * 一次打开的弹窗外壳:挂在 Modal 的 AnimatePresence 里,open 翻假后先播退场、退场
 * 结束才真正卸载——卸载时 close() 才把焦点还给触发器,Esc(onCancel)路径不变。
 * 退场全程是真实 DOM,表单控件的当前值(如受控 select 的选中项)原样在场,不再有
 * 卸载快照克隆丢值的问题(fact F-A7686F9B)。
 */
function ModalSurface({ title, hint, wide = false, testId, footer, onClose, children }: ModalSurfaceProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const { enabled, reduced } = useEntryMotion();
  const enter: Transition = {
      duration: reduced ? MOTION_DURATION.reducedFade : MOTION_DURATION.overlayRise,
      ease: MOTION_EASE.out,
    },
    exit: Transition = {
      duration: reduced ? MOTION_DURATION.reducedFade : MOTION_DURATION.overlayFall,
      ease: MOTION_EASE.in,
    };
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
      <motion.div
        aria-hidden="true"
        className="glass-scrim pointer-events-none fixed inset-0"
        initial={enabled ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        exit={enabled ? { opacity: 0, transition: { ...exit, ease: MOTION_EASE.out } } : undefined}
        transition={enter}
      />
      <motion.div
        className={`glass glass-overlay mx-auto flex max-h-[var(--overlay-content-cap)] w-full flex-col overflow-hidden rounded-xl shadow-2xl ${wide ? "max-w-[760px]" : "max-w-[640px]"}`}
        initial={enabled ? (reduced ? { opacity: 0 } : { opacity: 0, y: ENTER_DISTANCE }) : false}
        animate={{ opacity: 1, ...(reduced || !enabled ? {} : { y: 0 }) }}
        exit={
          enabled
            ? reduced
              ? { opacity: 0, transition: exit }
              : { opacity: 0, y: EXIT_DISTANCE, transition: exit }
            : undefined
        }
        transition={enter}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
          <b className="ui-body font-[650]">{title}</b>
          {hint && <span className="ui-micro text-text-faint">{hint}</span>}
          <span className="ml-auto">
            <Button variant="ghost" ariaLabel={t("components.primitives.close")} onClick={onClose}>
              ✕
            </Button>
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">{children}</div>
        {footer !== undefined && <footer className="shrink-0 border-t border-border px-3.5 py-2.5">{footer}</footer>}
      </motion.div>
    </dialog>
  );
}

export function Modal({
  open,
  title,
  hint,
  wide = false,
  testId,
  footer,
  onClose,
  children,
}: ModalSurfaceProps & { readonly open: boolean }) {
  // Callers commonly clear their guarded object together with open. Keep the
  // closing frame's title/content/footer mounted until AnimatePresence exits.
  const snapshot = useRef<{ readonly title: string; readonly children: ReactNode; readonly footer: ReactNode } | null>(
    null,
  );
  if (open) snapshot.current = { title, children, footer };
  const shown = snapshot.current;
  return (
    <AnimatePresence>
      {open && (
        <ModalSurface
          key="modal-surface"
          title={shown?.title ?? title}
          hint={hint}
          wide={wide}
          testId={testId}
          footer={shown?.footer ?? footer}
          onClose={onClose}
        >
          {shown?.children ?? children}
        </ModalSurface>
      )}
    </AnimatePresence>
  );
}
