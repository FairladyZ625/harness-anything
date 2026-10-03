import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { proseMinimumHeight, regionMinimumHeight } from "./region-minimum.ts";

/**
 * 区域板的列容器(标准 §2.1):「固定顺序 + 固定右列」这一类概览(工作概况、各实体页的
 * 概况页签、研发态势)共用。主区一列或两列 + 最右一列(时间线、模板、任务节奏这类占满
 * 列高的长列表);列内区域按内容高度分配,放不下时各自缩到实测下限(条目区至少露出三条,
 * 正文区至少露出约三行),再放不下就列内滚动;每个区域的内容在 Region 内部滚动。
 * 断点量的是最近的 @container 祖先:≥900px 两列(没有右列时主区占满),≥1400px 主区的每个
 * BoardColumn 自成一列并与右列等宽,更窄时单列纵排、右列排到最下、整页滚动(§1.9)。
 *
 * 两列时的列宽只有两种,由右列放的是什么定(side):
 *   aside(默认)  右列是辅助的窄内容(时间线、模板):主区 3 份 | 右列 2 份。
 *   primary      右列是这一页的主列表,每行信息量大(任务节奏、运行历史):各占一半。
 *
 * 全局总览不用它:那一页按 daemon 权重把区域落进当前最矮的一列(overview-layout),保证
 * 不了某个区域固定在右列。
 *
 * split(task_fb3ba20d66…,工作概况主区|最近进展):给 split 时用户显式排列/比例接管——
 * 板变「主区 | 分隔条 | 右列」的固定两窗(≥1400px 的三列展开不再生效,主区恒为一列内滚),
 * 比例与分隔条由调用方的 useSplitLayout 持有;不给 split 时行为与本类原有的自适应完全一致。
 *
 * 用法:板放在一个 ≥900px 时有确定高度的弹性列里。
 *   <RegionBoard>
 *     <BoardMain>
 *       <BoardColumn><BoardRegion region="mine"><Region …/></BoardRegion>…</BoardColumn>
 *       <BoardColumn>…</BoardColumn>
 *     </BoardMain>
 *     <BoardSide region="recent"><Region …/></BoardSide>
 *   </RegionBoard>
 */

const MinimumContext = createContext<Readonly<Record<string, number>>>({});
/** split 模式标记:BoardMain/BoardColumn 据此放弃 ≥1400px 的自身成列展开。 */
const BoardSplitContext = createContext(false);

/** 区域行体里算「一条」的元素:DenseRow、时间线的天摘要与路径行。 */
const REGION_ROWS = "[data-dense-row], [data-day] > button, [data-day] > div > *";

const TWO_COLUMNS = {
  aside: "@[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
  primary: "@[900px]:grid-cols-2",
} as const;

/** split 模式的板级形状:主区占 ratio,中间是分隔条(调用方给),右列占余量。 */
export interface RegionBoardSplit {
  readonly orientation: "row" | "column";
  readonly ratio: number;
  /** 分隔条节点(通常来自 SplitDivider);作为最后一个子元素之前插入。 */
  readonly divider: ReactNode;
  /** 分割容器的量尺(useSplitLayout.containerRef);板把它并到自己的根 div 上。 */
  readonly containerRef?: (element: HTMLDivElement | null) => void;
}

function splitBoardTemplate(split: RegionBoardSplit): CSSProperties {
  const first = `${(split.ratio * 100).toFixed(2)}fr`,
    rest = `${((1 - split.ratio) * 100).toFixed(2)}fr`;
  return split.orientation === "row"
    ? {
        gridTemplateColumns: `minmax(0,${first}) 0.375rem minmax(0,${rest})`,
        gridTemplateRows: "minmax(0,1fr)",
      }
    : {
        gridTemplateRows: `minmax(0,${first}) 0.375rem minmax(0,${rest})`,
        gridTemplateColumns: "minmax(0,1fr)",
      };
}

export function RegionBoard({
  side = "aside",
  split,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  readonly side?: keyof typeof TWO_COLUMNS;
  readonly split?: RegionBoardSplit;
}) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  // split 模式把调用方的量尺并到同一根 div:区域下限测量与比例换算量的是同一个盒子。
  // 量尺引用在 hook 里是稳定的,这里的回调不随渲染换身份,ref 不反复重挂。
  const splitContainerRef = split?.containerRef;
  const boardElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      boardRef.current = element;
      splitContainerRef?.(element);
    },
    [splitContainerRef],
  );
  const [minimum, setMinimum] = useState<Readonly<Record<string, number>>>({});
  // 每次渲染后重量:区域增减、行数变化都改变下限,不让调用方记得传依赖。
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (board === null) return;
    const measure = () => {
      const next: Record<string, number> = {};
      for (const region of board.querySelectorAll<HTMLElement>("[data-region]")) {
        const section = region.querySelector("section"),
          height =
            section === null
              ? undefined
              : (regionMinimumHeight(section, (body) => [...body.querySelectorAll(REGION_ROWS)]) ??
                proseMinimumHeight(section));
        if (height !== undefined) next[region.dataset.region!] = height;
      }
      setMinimum((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    // 行体内容变高(展开某一天、字号或宽度变化)时重量。
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    for (const element of board.querySelectorAll(
      "[data-region] > section > div, [data-region] > section > div > div > *",
    ))
      observer.observe(element);
    measure();
    return () => observer.disconnect();
  });
  // split 模式:分隔条插在最后一个子元素(右列)之前;无分隔轨道间隙,条即接缝。
  const items = Children.toArray(children);
  const ordered =
    split !== undefined && items.length >= 2 && isValidElement(split.divider)
      ? [...items.slice(0, -1), cloneElement(split.divider, { key: "board-split-divider" }), items.at(-1)!]
      : children;
  return (
    <MinimumContext.Provider value={minimum}>
      <BoardSplitContext.Provider value={split !== undefined}>
        <div
          {...props}
          ref={boardElementRef}
          className={
            split === undefined
              ? `grid grid-cols-1 gap-2 @[900px]:min-h-0 @[900px]:flex-1 ${TWO_COLUMNS[side]} @[900px]:grid-rows-[minmax(0,1fr)] @[1400px]:grid-flow-col @[1400px]:auto-cols-[minmax(0,1fr)] @[1400px]:grid-cols-none`
              : "grid min-h-0 flex-1"
          }
          style={split === undefined ? undefined : splitBoardTemplate(split)}
        >
          {ordered}
        </div>
      </BoardSplitContext.Provider>
    </MinimumContext.Provider>
  );
}

/** 主区:两列时是右列左边那一列(没有右列时占满板宽)并列内滚动;≥1400px 让位给它的 BoardColumn。 */
export function BoardMain({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  // split 板上主区恒为一列内滚(≥1400px 不再展开成多列,比例给的是主区整体)。
  const splitBoard = useContext(BoardSplitContext);
  return (
    <div
      {...props}
      className={
        splitBoard
          ? "flex min-w-0 flex-col gap-2 overflow-y-auto"
          : "flex min-w-0 flex-col gap-2 @[900px]:min-h-0 @[900px]:overflow-y-auto @[900px]:only:col-span-full @[1400px]:contents"
      }
    >
      {children}
    </div>
  );
}

/** 主区的一列:≥1400px 时自成一列并列内滚动,否则并入主区那一列。 */
export function BoardColumn({ children }: Pick<HTMLAttributes<HTMLDivElement>, "children">) {
  const splitBoard = useContext(BoardSplitContext);
  return (
    <div
      className={
        splitBoard
          ? "contents"
          : "contents @[1400px]:flex @[1400px]:min-h-0 @[1400px]:min-w-0 @[1400px]:flex-col @[1400px]:gap-2 @[1400px]:overflow-y-auto"
      }
    >
      {children}
    </div>
  );
}

/**
 * 列内一个区域的外框:单列时限高(一条长列表不把后面的区域推出屏幕),多列时按内容高度
 * 参与列内分配并可被压到实测下限(条目区:前三条;正文区:约三行)。Region 原语被拉伸到
 * 这个盒子。
 *
 * fill 给整篇文档这类该吃掉剩余高度的区域:占满列内其余区域按内容取完之后剩下的高度,文档在
 * 区域内滚动。16rem 的下限保的是「文档区至少露出十来行可读正文」——同列条目再多,也是
 * 整列滚动,不把文档区压成一条缝。
 */
export function BoardRegion({
  region,
  fill = false,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly region: string; readonly fill?: boolean }) {
  const minimum = useContext(MinimumContext)[region] ?? 0;
  return (
    <div
      {...props}
      data-region={region}
      className={`grid min-w-0 max-h-[var(--long-content-cap)] grid-rows-[minmax(0,1fr)] @[900px]:max-h-none ${
        fill ? "@[900px]:min-h-[16rem] @[900px]:flex-[1_1_100%]" : "@[900px]:flex-[1_1_auto]"
      }`}
      style={fill ? undefined : { minHeight: minimum }}
    >
      {children}
    </div>
  );
}

/** 板上最右一列(单列时排到最下):只放一个区域,占满列高,内容在 Region 内部滚动。 */
export function BoardSide({
  region,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly region: string }) {
  return (
    <div
      {...props}
      data-region={region}
      className="grid max-h-[var(--long-content-cap)] min-w-0 grid-rows-[minmax(0,1fr)] @[900px]:max-h-none @[900px]:min-h-0"
    >
      {children}
    </div>
  );
}
