import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 轻量气泡弹窗:一个触发按钮 + 挂在它下方的面板。面板 portal 到 body 并 fixed 定位,
 * 不受侧栏 overflow 裁剪;水平方向夹在视口内。Esc / 点外面关闭;children 拿到 close,
 * 选中项后自行收起。
 */
export function Popover({
  label,
  trigger,
  panelClassName = "w-72",
  testId,
  children,
}: {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly panelClassName?: string;
  readonly testId?: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = buttonRef.current?.getBoundingClientRect();
    const width = panelRef.current?.offsetWidth ?? 0;
    if (!anchor) return;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    setPosition({ top: anchor.bottom + 4, left });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      buttonRef.current?.contains(target as Node | null) || panelRef.current?.contains(target as Node | null);
    const onMouseDown = (event: MouseEvent) => {
      if (!inside(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // 面板里展开中的 combobox(task 选择器)自己消费 Esc 收列表,气泡不跟着关。
      const target = event.target as HTMLElement | null;
      const comboboxOpen =
        target?.getAttribute?.("role") === "combobox" && target.getAttribute("aria-expanded") === "true";
      if (event.key === "Escape" && !comboboxOpen) setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid={testId}
        onClick={() => setOpen((current) => !current)}
        className={[
          "grid size-7 place-items-center rounded border border-border text-text-muted",
          "hover:border-border-strong hover:bg-surface-raised hover:text-text",
          open ? "border-accent/60 bg-accent/10 text-text" : "",
        ].join(" ")}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            data-testid={testId ? `${testId}-panel` : undefined}
            style={{ top: position.top, left: position.left }}
            className={[
              "fixed z-50 max-h-[70vh] max-w-[calc(100vw-1rem)] overflow-y-auto rounded border border-border-strong",
              "bg-surface-raised",
              "p-2 text-[12px] shadow-2xl",
              panelClassName,
            ].join(" ")}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}
