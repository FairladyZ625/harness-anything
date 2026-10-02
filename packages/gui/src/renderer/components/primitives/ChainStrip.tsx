import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * 单行串联横滚容器(标准 §4「收束,不堆叠」):任意多个值串联成的链(状态步骤、
 * 实体链接、继承组)单行呈现,超出容器宽在自身内部横向滚动——不换行、不随项数
 * 撑高外部行。滚动条隐藏(chain-strip):行高不随是否溢出变化。
 *
 * 键盘与提示(视觉规范 v2 整改):溢出时滚动区变为原生可焦点 scroll region
 * (tabindex=0 + role=group,焦点 ring 走全局 :focus-visible),并渲染右缘可见溢出
 * 提示(›,aria-hidden);不溢出时不进 tab 序、不出提示,不给短链增加噪音。
 * 方向键/Home/End 的平移由组件显式承担:Chromium 对焦点滚动区(尤其行按钮内的)
 * 不保证默认平移,实测不动;仅链自身聚焦时处理这四个键,不拦截其它键。横向滚轮
 * 同理由链消费(Chromium 滚轮锁存会停在链内 overflow:hidden 的行内子项上,实测
 * 链接上滚不动),纵向滚轮不拦、继续冒泡给外层纵滚面。
 * 子项由调用方给 flex-none/不换行,溢出才成立。
 */
export function ChainStrip({
  children,
  label,
  testId,
  className = "",
}: {
  readonly children: ReactNode;
  /** 可聚焦滚动区的可访问名:聚焦时朗读链的语义(如「进展步骤链」)。 */
  readonly label: string;
  readonly testId?: string;
  /** 叠加在外层 flex 容器上的类(如正文场景的 w-full)。 */
  readonly className?: string;
}) {
  const stripRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const measure = () => {
    const el = stripRef.current;
    if (el !== null) setOverflowing(el.scrollWidth - el.clientWidth > 1);
  };
  // 子项变化不改变盒子尺寸、不触发 ResizeObserver,渲染后补测一次;同值 setState
  // 自动 bail out,不会循环。
  useLayoutEffect(measure);
  useEffect(() => {
    const el = stripRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOverflowing(el.scrollWidth - el.clientWidth > 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Chromium 的滚轮锁存会停在链内自带 overflow:hidden 的行内子项(如 EntityRefLink
  // 的截断基),横向滚轮到不了链本身(实测:落在链像素上默认滚动生效,落在链接上不动)。
  // 横向意图(deltaX 主导)由链自身消费;纵向滚轮不拦,继续冒泡给外层纵滚面。
  useEffect(() => {
    const el = stripRef.current;
    if (el === null) return;
    const panOnWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      el.scrollLeft += event.deltaX;
    };
    el.addEventListener("wheel", panOnWheel, { passive: false });
    return () => el.removeEventListener("wheel", panOnWheel);
  }, []);
  const panOnKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    const el = stripRef.current;
    if (el === null) return;
    if (event.key === "ArrowRight") el.scrollBy({ left: 40 });
    else if (event.key === "ArrowLeft") el.scrollBy({ left: -40 });
    else if (event.key === "Home") el.scrollTo({ left: 0 });
    else if (event.key === "End") el.scrollTo({ left: el.scrollWidth });
    else return;
    event.preventDefault();
  };
  return (
    <span data-chain-strip="" className={`flex min-w-0 items-center gap-1 ${className}`}>
      <span
        ref={stripRef}
        data-testid={testId}
        data-chain-scroll=""
        role="group"
        aria-label={label}
        tabIndex={overflowing ? 0 : undefined}
        onKeyDown={panOnKey}
        className="chain-strip flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {children}
      </span>
      {overflowing && (
        <span data-chain-hint="" aria-hidden className="flex-none select-none text-text-faint ui-micro">
          ›
        </span>
      )}
    </span>
  );
}
