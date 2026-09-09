import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

const KEYBOARD_STEP = 16;

/**
 * 看板列宽手柄(W11,三布局共用):TerminalChrome 侧栏的 pointer 拖拽模式
 * (按下后在 window 上跟指针,松手收听)加上键盘可达——可 Tab 聚焦,←/→ 微调。
 *
 * 摆放不变量:手柄必须是「列容器」的直接子元素,基类自带 position:absolute,
 * 列容器须为 relative,消费方只补 inset 偏移类。未定宽的列(width 未传)在
 * 拖拽/键盘起点用父元素的实测宽度作基准,已定宽列直接用状态值。宽度状态与
 * 持久化都由调用方(各看板视图)持有,本组件只汇报目标宽度。
 */
export function ColumnResizeHandle({
  label,
  width,
  min,
  max,
  onChange,
  onReset,
  className = "",
  testId,
}: {
  /** 无障碍名,如「调整「Active」列宽」。 */
  label: string;
  /** 当前持久化宽度;undefined = 该列仍走默认布局。 */
  width: number | undefined;
  min: number;
  max: number;
  onChange: (px: number) => void;
  /** 双击恢复默认布局;不传则双击无操作。 */
  onReset?: () => void;
  /** 定位偏移类(如 inset-y-0 -right-1.5);position:absolute 与光标/触摸/焦点样式已内置。 */
  className?: string;
  testId?: string;
}) {
  const clamp = (px: number) => Math.min(max, Math.max(min, Math.round(px)));
  // 未定宽列的基准 = 父元素(列容器)的实测宽度;测不到(SSR)时退 min。
  const baseWidth = (element: HTMLElement) =>
    width ?? Math.round(element.parentElement?.getBoundingClientRect().width ?? min);

  // 拖拽监听的唯一 owner:ref 持当前收尾函数,pointerup/pointercancel、开始新拖拽
  // 前与组件卸载都走它——取消或中途卸载后不再有 stale onChange 继续写宽度。
  const stopDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDragRef.current?.(), []);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDragRef.current?.();
    const origin = event.clientX;
    const base = baseWidth(event.currentTarget);
    const onMove = (move: PointerEvent) => onChange(clamp(base + move.clientX - origin));
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      stopDragRef.current = null;
    };
    stopDragRef.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  // 未定宽列也要向辅助技术报现值:挂载(及宽度回落 undefined 时)量一次父元素
  // 实际宽度作 aria-valuenow;量不出正宽度(无布局引擎的环境)保持省略。
  const handleRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>();
  useEffect(() => {
    if (width !== undefined) return;
    const px = Math.round(handleRef.current?.parentElement?.getBoundingClientRect().width ?? 0);
    if (px > 0) setMeasuredWidth(px);
  }, [width]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -KEYBOARD_STEP : KEYBOARD_STEP;
    onChange(clamp(baseWidth(event.currentTarget) + step));
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width ?? measuredWidth}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      title={`${label}(拖拽调宽 · ←/→ 微调${onReset ? " · 双击恢复默认" : ""})`}
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={[
        // absolute 必须在共享基类:手柄自身无内容,静态流里高度恒为 0,inset-* 全部
        // 失效,鼠标无命中区(2026-09-09 真机验收实证);父容器按不变量已是 relative。
        "absolute z-10 w-3 cursor-col-resize touch-none select-none",
        "hover:bg-accent/30 focus-visible:bg-accent/50 focus-visible:outline-none",
        className,
      ].join(" ")}
    />
  );
}
