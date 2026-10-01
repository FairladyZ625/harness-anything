import { createContext, useContext, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { regionMinimumHeight } from "./region-minimum.ts";

/**
 * 区域板的列容器(标准 §2.1):「固定顺序 + 右侧时间线」这一类概览(工作概况、各实体页的
 * 概况页签)共用。主区一列或两列 + 最右一列时间线;列内区域按内容高度分配,放不下时各自
 * 缩到「至少露出三条」的实测下限,再放不下就列内滚动;每个区域的内容在 Region 内部滚动。
 * 断点量的是最近的 @container 祖先:≥900px 两列(主区 | 时间线),≥1400px 主区的每个
 * BoardColumn 自成一列,更窄时单列纵排、时间线排到最下、整页滚动(§1.9)。
 *
 * 全局总览不用它:那一页按 daemon 权重把区域落进当前最矮的一列(overview-layout),保证
 * 不了时间线固定在右列。
 *
 * 用法:板放在一个 ≥900px 时有确定高度的弹性列里。
 *   <RegionBoard>
 *     <BoardMain>
 *       <BoardColumn><BoardRegion region="mine"><Region …/></BoardRegion>…</BoardColumn>
 *       <BoardColumn>…</BoardColumn>
 *     </BoardMain>
 *     <BoardTimeline><Region …/></BoardTimeline>
 *   </RegionBoard>
 */

const MinimumContext = createContext<Readonly<Record<string, number>>>({});

/** 区域行体里算「一条」的元素:DenseRow、时间线的天摘要与路径行。 */
const REGION_ROWS = "[data-dense-row], [data-day] > button, [data-day] > div > *";

export function RegionBoard({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const boardRef = useRef<HTMLDivElement | null>(null);
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
              : regionMinimumHeight(section, (body) => [...body.querySelectorAll(REGION_ROWS)]);
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
  return (
    <MinimumContext.Provider value={minimum}>
      <div
        {...props}
        ref={boardRef}
        className="grid grid-cols-1 gap-2 @[900px]:min-h-0 @[900px]:flex-1 @[900px]:grid-cols-2 @[900px]:grid-rows-[minmax(0,1fr)] @[1400px]:grid-flow-col @[1400px]:auto-cols-[minmax(0,1fr)] @[1400px]:grid-cols-none"
      >
        {children}
      </div>
    </MinimumContext.Provider>
  );
}

/** 主区:两列时是时间线左边那一列并列内滚动;≥1400px 让位给它的 BoardColumn。 */
export function BoardMain({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className="flex min-w-0 flex-col gap-2 @[900px]:min-h-0 @[900px]:overflow-y-auto @[1400px]:contents"
    >
      {children}
    </div>
  );
}

/** 主区的一列:≥1400px 时自成一列并列内滚动,否则并入主区那一列。 */
export function BoardColumn({ children }: Pick<HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className="contents @[1400px]:flex @[1400px]:min-h-0 @[1400px]:min-w-0 @[1400px]:flex-col @[1400px]:gap-2 @[1400px]:overflow-y-auto">
      {children}
    </div>
  );
}

/**
 * 列内一个区域的外框:单列时限高(一条长列表不把后面的区域推出屏幕),多列时按内容高度
 * 参与列内分配并可被压到实测下限。Region 原语被拉伸到这个盒子。
 *
 * fill 给整篇文档这类没有「条」的区域:占满列内其余区域按内容取完之后剩下的高度,文档在
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
      className={`grid min-w-0 max-h-[420px] grid-rows-[minmax(0,1fr)] @[900px]:max-h-none ${
        fill ? "@[900px]:min-h-[16rem] @[900px]:flex-[1_1_100%]" : "@[900px]:flex-[1_1_auto]"
      }`}
      style={fill ? undefined : { minHeight: minimum }}
    >
      {children}
    </div>
  );
}

/** 时间线:板上最右一列(单列时排到最下),占满列高,内容在 Region 内部滚动。 */
export function BoardTimeline({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      data-region="recent"
      className="grid max-h-[420px] min-w-0 grid-rows-[minmax(0,1fr)] @[900px]:max-h-none @[900px]:min-h-0"
    >
      {children}
    </div>
  );
}
