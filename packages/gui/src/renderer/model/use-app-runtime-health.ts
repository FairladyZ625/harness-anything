import { useMemo } from "react";
import { deriveRuntimeHealth, type RuntimeHealth, type RuntimeHealthInput } from "./runtime-health.ts";

/**
 * App 级运行时健康派生(口径注释见 model/runtime-health.ts;原总览第四格,2026-08-31
 * 收纳进侧栏后改为常驻派生)。daemon 响应折算自 systemQuery 成败 + observedAt 年龄;
 * 投影落后取 tasksQuery 的同一对数字;最近快照取当前仓任务行的 lastKnownAt 最大值。
 */
export function useAppRuntimeHealth(input: {
  /** systemQuery 折算:查询成败 + observedAt + uptime;没回来过给 null。 */
  readonly daemon: RuntimeHealthInput["daemon"];
  /** 当前仓(无选中仓给 null);cellState/queueDepth/lastError 进 repo 档。 */
  readonly repo: RuntimeHealthInput["repo"];
  /** tasksQuery 折算:watermark/sourceRevision/status;没回来过给 null。 */
  readonly projection: RuntimeHealthInput["projection"];
  /** 只在首次查询实际发出时显示加载,未选仓的 disabled query 仍是未知。 */
  readonly projectionLoading: boolean;
  /** 当前仓任务行(只取 lastKnownAt 求最大,作 lastSnapshotAt)。 */
  readonly projectTasks: readonly { readonly lastKnownAt: string }[];
}): RuntimeHealth {
  const { daemon, repo, projection, projectionLoading, projectTasks } = input;
  return useMemo(() => {
    const lastSnapshotAt = projectTasks.reduce(
      (latest, task) => (task.lastKnownAt > latest ? task.lastKnownAt : latest),
      "",
    );
    return deriveRuntimeHealth({
      daemon,
      repo,
      projection,
      projectionLoading,
      lastSnapshotAt: lastSnapshotAt || null,
      now: new Date().toISOString(),
    });
  }, [daemon, projection, projectionLoading, projectTasks, repo]);
}
