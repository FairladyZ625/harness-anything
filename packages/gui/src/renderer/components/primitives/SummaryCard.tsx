import type { CSSProperties, ReactNode } from "react";
import { StatusTag, TONE_COLOR, type StatusTone } from "./StatusTag.tsx";

/**
 * 概况卡(标准 §4):条目本身有构成(进度、运行历史、在等谁)时用它,一眼看出大致情况;
 * 条目只是一句话时仍用 DenseRow。三档大小跟着注意力走——要人出手的用大卡,正常推进的
 * 用小卡,不用管的用小方块沉底。卡上的阅读顺序固定:它是什么(标题)→ 为什么要你看
 * (CardReason)→ 构成 → 谁在跑/最近发生了什么,后三段由调用方按这个顺序放进 children。
 * 外观与实体页卡片同一套边框、圆角、底色;高度随内容,不设固定高度。
 */
export type SummaryCardSize = "large" | "small" | "tile";

/** 列数只按组容器自己的宽度判断(标准 §1.9⑤),不看窗口宽度。 */
const GRID_COLUMNS: Record<SummaryCardSize, string> = {
  large: "grid-cols-1 @[900px]:grid-cols-2",
  small: "grid-cols-1 @[560px]:grid-cols-2 @[900px]:grid-cols-3 @[1400px]:grid-cols-4",
  tile: "grid-cols-1 @[420px]:grid-cols-2 @[900px]:grid-cols-4",
};

const TITLE_TYPE: Record<SummaryCardSize, string> = {
  large: "text-base font-semibold leading-snug",
  small: "font-semibold ui-body",
  tile: "font-medium ui-body",
};

/** 一档卡片的网格;给了 title 就在上面出一行组标题「名称 + 个数」。组自己是容器量尺。 */
export function SummaryCardGroup({
  size,
  title,
  count,
  testId,
  children,
}: {
  readonly size: SummaryCardSize;
  readonly title?: ReactNode;
  readonly count?: number;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <section data-testid={testId} data-card-size={size} className="@container">
      {title !== undefined && (
        <h2 className="mb-2 flex items-baseline gap-2 font-semibold text-text ui-meta">
          {title}
          {count !== undefined && <span className="font-mono font-normal tabular-nums text-text-faint">{count}</span>}
        </h2>
      )}
      <div className={`grid gap-2.5 ${GRID_COLUMNS[size]}`}>{children}</div>
    </section>
  );
}

/**
 * 一张概况卡。整张卡可点进详情(标题是键盘可达的按钮,点击冒泡到卡);卡内不嵌第二个
 * 可点目标,唯一例外放 `action`(它的点击不触发进入详情)。`tone` 点亮左侧状态色竖线。
 */
export function SummaryCard({
  size,
  title,
  subtitle,
  aside,
  action,
  tone,
  onOpen,
  testId,
  attrs,
  children,
}: {
  readonly size: SummaryCardSize;
  readonly title: ReactNode;
  /** 标题下的一行弱色补充。 */
  readonly subtitle?: ReactNode;
  /** 标题行右侧的一个关键量(相对时间)。 */
  readonly aside?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: StatusTone;
  readonly onOpen?: () => void;
  readonly testId?: string;
  readonly attrs?: Readonly<Record<`data-${string}`, string>>;
  readonly children?: ReactNode;
}) {
  const titleCls = `line-clamp-2 break-words text-text ${TITLE_TYPE[size]}`;
  return (
    <article
      {...attrs}
      data-testid={testId}
      data-summary-card={size}
      onClick={onOpen}
      className={`status-edge relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors ${
        size === "large" ? "gap-2.5 p-3.5" : "gap-1.5 px-3.5 py-3"
      } ${onOpen === undefined ? "" : "cursor-pointer hover:border-border-strong"}`}
      style={tone === undefined ? undefined : ({ "--status-edge": TONE_COLOR[tone] } as CSSProperties)}
    >
      <header className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          {onOpen === undefined ? (
            <h3 className={titleCls}>{title}</h3>
          ) : (
            <button type="button" className={`block w-full cursor-pointer text-left ${titleCls}`}>
              {title}
            </button>
          )}
          {subtitle !== undefined && <p className="mt-0.5 truncate text-text-faint ui-meta">{subtitle}</p>}
        </div>
        {aside !== undefined && (
          <span className="shrink-0 whitespace-nowrap pt-0.5 font-mono tabular-nums text-text-muted ui-meta">
            {aside}
          </span>
        )}
        {action !== undefined && (
          <span className="shrink-0" onClick={(event) => event.stopPropagation()}>
            {action}
          </span>
        )}
      </header>
      {children}
    </article>
  );
}

/** 原因行:一个状态标签加一句话,最多两行——「为什么要你看」在卡上第二显眼。 */
export function CardReason({
  tone,
  label,
  children,
}: {
  readonly tone: StatusTone;
  readonly label: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <p className="flex min-w-0 items-start gap-2 ui-meta">
      <span className="shrink-0">
        <StatusTag tone={tone} label={label} />
      </span>
      {children !== undefined && <span className="line-clamp-2 min-w-0 break-words text-text">{children}</span>}
    </p>
  );
}
