import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 轻量气泡弹窗:一个触发按钮 + 挂在它下方的面板。面板 portal 到 body 并 fixed 定位,
 * 不受侧栏 overflow 裁剪;水平方向夹在视口内。Esc / 点外面关闭;children 拿到 close,
 * 选中项后自行收起。
 */
/** 祖先气泡 id 链:嵌套气泡的面板 portal 到 body 后不在父面板 DOM 里,靠它判断「点在后代里不算点外面」。 */
const PopoverAncestors = createContext<readonly string[]>([]);

export function Popover({
  label,
  trigger,
  panelClassName = "w-72",
  triggerClassName,
  testId,
  children,
}: {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly panelClassName?: string;
  /** 覆盖触发按钮样式(默认是 7×7 的图标按钮;task 选择器要一个显示当前值的宽按钮)。 */
  readonly triggerClassName?: string;
  readonly testId?: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const id = useId();
  const ancestors = useContext(PopoverAncestors);
  const chain = [...ancestors, id];
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
    const inside = (target: EventTarget | null) => {
      const node = target as Node | null;
      if (buttonRef.current?.contains(node) || panelRef.current?.contains(node)) return true;
      const owner = (node as Element | null)?.closest?.("[data-popover-ancestors]") as HTMLElement | null;
      return owner?.dataset.popoverAncestors?.split(" ").includes(id) ?? false;
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!inside(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc 落在后代气泡里时由后代处理(它自己会关),本层不动。
      const target = event.target as HTMLElement | null;
      const inDescendant = Boolean(
        target?.closest?.("[data-popover-ancestors]") && !panelRef.current?.contains(target),
      );
      if (event.key === "Escape" && !inDescendant) setOpen(false);
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
        className={
          triggerClassName ??
          [
            "grid size-7 place-items-center rounded border border-border text-text-muted",
            "hover:border-border-strong hover:bg-surface-raised hover:text-text",
            open ? "border-accent/60 bg-accent/10 text-text" : "",
          ].join(" ")
        }
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
            data-popover-ancestors={chain.join(" ")}
            style={{ top: position.top, left: position.left }}
            className={[
              "fixed z-50 max-h-[70vh] max-w-[calc(100vw-1rem)] overflow-y-auto rounded border border-border-strong",
              "bg-surface-raised",
              "p-2 text-[12px] shadow-2xl",
              panelClassName,
            ].join(" ")}
          >
            <PopoverAncestors.Provider value={chain}>{children(() => setOpen(false))}</PopoverAncestors.Provider>
          </div>,
          document.body,
        )}
    </>
  );
}
