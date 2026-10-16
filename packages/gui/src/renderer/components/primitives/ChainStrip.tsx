import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * 单行串联横滚容器(标准 §4「收束,不堆叠」):任意多个值串联成的链(状态步骤、
 * 实体链接、继承组)单行呈现,超出容器宽在自身内部横向滚动——不换行、不随项数
 * 撑高外部行。滚动条隐藏(chain-strip):行高不随是否溢出变化。
 *
 * 键盘与提示:溢出时链变为可焦点组(tabindex=0 + role=group,焦点 ring 走全局
 * :focus-visible),滚动区由共享 scroll-fade-x mask 在两端羽化——未到头的一侧
 * 渐隐提示还有内容,到头即消失,不溢出时不显示(取代旧的右缘「›」静态提示)。
 * tabindex 落在外层:渐隐 mask 挂在滚动区上,会连同它自己的焦点环一起裁掉。
 * 方向键/Home/End 的横向平移由组件承担;标题按钮应放在滚动区之外,避免空格键
 * 触发祖先按钮。横向滚轮同理由链消费(Chromium 滚轮锁存会停在链内 overflow:hidden
 * 的行内子项上,实测链接上滚不动),纵向滚轮不拦、继续冒泡给外层纵滚面。
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
    <span
      data-chain-strip=""
      role="group"
      aria-label={label}
      tabIndex={overflowing ? 0 : undefined}
      onKeyDown={panOnKey}
      className={`flex min-w-0 items-center ${className}`}
    >
      <span
        ref={stripRef}
        data-testid={testId}
        data-chain-scroll=""
        className="chain-strip scroll-fade-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {children}
      </span>
    </span>
  );
}
