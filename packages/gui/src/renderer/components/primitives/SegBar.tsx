import type { SnapshotStatus } from "../../model/types";
import { STATUS_TONE, TONE_COLOR } from "./StatusTag";

/** 分段顺序:先「已经有果」的绿,再在途按注意力排,取消与未知垫底。 */
const SEGMENT_ORDER: readonly SnapshotStatus[] = [
  "done",
  "active",
  "submitted",
  "in_review",
  "blocked",
  "planned",
  "cancelled",
  "unknown",
  "archived",
];

/**
 * 状态分段进度条(标准 §4):宽度按任务数、颜色按状态构成,用于工作、子组与区域。
 * 颜色全部经 STATUS_TONE → TONE_COLOR 取 token,调用点只给计数。
 * active 分段曾有高光流淌循环(seg-active-shimmer),2026-10-18 二轮定性为装饰性
 * 永续动效删除(task_5c651ff17b698ff2bce7e6affa):在途语义由状态色本身承担。
 */
export function SegBar({
  counts,
  className,
}: {
  readonly counts: Readonly<Partial<Record<SnapshotStatus, number>>>;
  readonly className?: string;
}) {
  const total = SEGMENT_ORDER.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  return (
    <div aria-hidden="true" className={`flex h-1 overflow-hidden rounded-xs bg-text/10 ${className ?? ""}`}>
      {total > 0 &&
        SEGMENT_ORDER.filter((status) => (counts[status] ?? 0) > 0).map((status) => (
          <span
            key={status}
            data-segment={status}
            className="block h-full"
            style={{
              width: `${((counts[status] ?? 0) / total) * 100}%`,
              background: TONE_COLOR[STATUS_TONE[status]],
            }}
          />
        ))}
    </div>
  );
}
