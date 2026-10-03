import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "@phosphor-icons/react";
import { t } from "../../i18n/index.tsx";
import { TONE_COLOR, type StatusTone } from "./StatusTag";

/**
 * 原位放大层(标准 §4):共享布局动画从原位长到中央(与 Region 的 focusId 配对),
 * 背后 scrim 毛玻璃;左列表右详情;Esc/点背景收回;↑↓ 在列表中移动选中。
 *
 * 选中态由调用方持有(数据归页面,原语只管呈现与交互);itemIds 是左列表可选中
 * 条目的 id 序列,↑↓ 在其中按序移动。从原位长出依赖 Region 渲染同名 focusId,
 * 调用方在打开时隐藏原区域(visibility:hidden 即可,motion 会用它的盒子)并把 Region 的
 * focusOpen 置真。长出/收回缩放的只是外框,内容层保持原尺寸(文字不被拉伸);放大层开着时
 * 自身尺寸变化(窗口缩放)直接到位,不做布局过渡。
 */
export function FocusLayer({
  open,
  sourceId,
  title,
  tag,
  big,
  bigTone,
  toolbar,
  itemIds,
  selectedId,
  onSelect,
  onClose,
  list,
  detail,
}: {
  readonly open: boolean;
  readonly sourceId?: string;
  readonly title: ReactNode;
  readonly tag?: ReactNode;
  readonly big?: number | string;
  readonly bigTone?: StatusTone;
  readonly toolbar?: ReactNode;
  readonly itemIds: readonly string[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly list: ReactNode;
  readonly detail: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardSelection = useRef<string | null>(null);
  // Only an explicit key move follows the selection. Query refreshes and user scrolling
  // must not pull the list back to a previously selected row.
  useLayoutEffect(() => {
    if (open && keyboardSelection.current === selectedId) {
      listRef.current?.querySelector<HTMLElement>("[data-selected]")?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
    }
    keyboardSelection.current = null;
  }, [open, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (itemIds.length === 0) return;
      const current = itemIds.indexOf(selectedId ?? "");
      const next =
        event.key === "ArrowDown"
          ? Math.min(itemIds.length - 1, current + 1)
          : Math.max(0, current === -1 ? 0 : current - 1);
      event.preventDefault();
      if (itemIds[next] !== undefined && itemIds[next] !== selectedId) {
        keyboardSelection.current = itemIds[next];
        onSelect(itemIds[next]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, itemIds, selectedId, onClose, onSelect]);

  // Viewport overlays must escape transformed/clipped panel ancestors.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="focus-scrim"
          className="glass-scrim fixed inset-0 z-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          onClick={onClose}
        />
      )}
      {open && (
        <motion.div
          key="focus-layer"
          layoutId={sourceId}
          layoutDependency={sourceId}
          className="glass fixed inset-0 z-11 m-auto h-[min(84vh,860px)] w-[min(86vw,1320px)] overflow-hidden rounded-lg"
          transition={{ duration: 0.42, ease: [0.2, 0.85, 0.25, 1] }}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : undefined}
        >
          <motion.div layout="position" layoutDependency={sourceId} className="flex h-full flex-col">
            <div className="flex flex-none items-center gap-2.5 px-[18px] pb-[10px] pt-[14px]">
              <h2 className="min-w-0 truncate font-semibold ui-title">{title}</h2>
              {tag}
              {big !== undefined && (
                <span
                  className="ml-auto font-mono font-semibold leading-none tabular-nums ui-heading"
                  style={bigTone === undefined ? undefined : { color: TONE_COLOR[bigTone] }}
                >
                  {big}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label={t("components.primitives.close")}
                className="ml-3 grid size-[26px] shrink-0 place-items-center rounded-xs border border-border bg-text/10 text-text-muted hover:text-text"
              >
                <X weight="bold" className="ui-meta" />
              </button>
            </div>
            {toolbar !== undefined && (
              <div className="flex flex-none flex-wrap items-center gap-1.5 px-[18px] pb-2.5">{toolbar}</div>
            )}
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_minmax(20rem,1fr)]">
              {/* flex 列的默认拉伸让每个直接子行占满列宽:调用方传入的行/包装层不再依赖
                自身 display 参与块级流(行高亮曾止于内容宽度,S3 移交缺陷)。 */}
              <div
                ref={listRef}
                className="flex min-h-0 flex-col overflow-y-auto border-t border-border"
                data-focus-list
              >
                {list}
              </div>
              <div
                className="min-h-0 overflow-y-auto border-t border-border px-[18px] py-[14px] md:border-l"
                data-focus-detail
              >
                {detail}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
