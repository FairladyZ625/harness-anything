import { useEffect, useMemo, useRef } from "react";
import {
  deriveRuntimeHealth,
  EMPTY_RUNTIME_HEALTH_TRANSIENT,
  type RuntimeHealth,
  type RuntimeHealthInput,
  type RuntimeHealthMount,
  type RuntimeHealthTransient,
} from "./runtime-health.ts";

/**
 * App 级运行时健康派生(口径注释见 model/runtime-health.ts;原总览第四格,2026-08-31
 * 收纳进侧栏后改为常驻派生)。daemon 响应折算自 systemQuery 成败 + observedAt 年龄;
 * 投影落后取 tasksQuery 的同一对数字;最近快照取当前仓任务行的 lastKnownAt 最大值。
 *
 * 瞬时状态的起点(落后/无结论)跨快照保留在这一层:每次快照把上一轮的两个 since
 * 回传给纯派生,由它按新 now 算持续秒数。不新增定时器,轮询仍只有两个 query 自己的
 * 10s 节拍;切仓时计时归零,不把上一个仓的落后时长带过来。
 */
export function useAppRuntimeHealth(input: {
  /** 当前仓;切仓时瞬时状态的计时从 0 重来。 */
  readonly repoKey: string | null;
  /** systemQuery 折算:查询成败 + observedAt + uptime;没回来过给 null。 */
  readonly daemon: RuntimeHealthInput["daemon"];
  /** 当前仓(无选中仓给 null);cellState/queueDepth/lastError 进 repo 档。 */
  readonly repo: RuntimeHealthInput["repo"];
  /** tasksQuery 折算:watermark/sourceRevision/status/isolatedRows/hydrating;没回来过给 null。 */
  readonly projection: RuntimeHealthInput["projection"];
  /** 只在首次查询实际发出时显示加载,未选仓的 disabled query 仍是未知。 */
  readonly projectionLoading: boolean;
  /** systemQuery.repos 的 enabled 挂载进度;没读到给 null。 */
  readonly mount: RuntimeHealthMount | null;
  /** 当前仓任务行(只取 lastKnownAt 求最大,作 lastSnapshotAt)。 */
  readonly projectTasks: readonly { readonly lastKnownAt: string }[];
}): RuntimeHealth {
  const { daemon, repo, projection, projectionLoading, mount, projectTasks, repoKey } = input;
  const persisted = useRef<{ readonly repoKey: string | null; readonly transient: RuntimeHealthTransient }>({
    repoKey,
    transient: EMPTY_RUNTIME_HEALTH_TRANSIENT,
  });
  const health = useMemo(() => {
    const prior = persisted.current.repoKey === repoKey ? persisted.current.transient : undefined;
    const lastSnapshotAt = projectTasks.reduce(
      (latest, task) => (task.lastKnownAt > latest ? task.lastKnownAt : latest),
      "",
    );
    return deriveRuntimeHealth({
      daemon,
      repo,
      projection,
      projectionLoading,
      mount: mount ?? undefined,
      prior,
      lastSnapshotAt: lastSnapshotAt || null,
      now: new Date().toISOString(),
    });
  }, [daemon, projection, projectionLoading, mount, projectTasks, repo, repoKey]);
  useEffect(() => {
    persisted.current = { repoKey, transient: health.transient };
  }, [health, repoKey]);
  return health;
}
