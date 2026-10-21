import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { TaskRow } from "../../model/types.ts";
import type { TaskDispatchProjectionRow } from "../../../api/renderer-dto.ts";
import { harnessClient } from "../../api-client.ts";
import { runtimeQueryKeys } from "../../agent-runtime-client.ts";
import { dispatchRole } from "../../model/lineage-tree.ts";
import { t } from "../../i18n/index.tsx";
import { AgentLanes, type AgentLane, type AgentLaneTask } from "../agent-ui/AgentLanes.tsx";
import { Button } from "../primitives/Button.tsx";
import { Section } from "../primitives/Section.tsx";

/**
 * 任务预览里的执行泳道(R9):预览抽屉右侧按需展开,把该任务的派工轮次画成一条
 * AgentLanes。泳道是被复用组件而不是预览自造的步骤条——展开后看到的就是总览/现场页
 * 同一个时间线,块的交互(点击/键盘/待拍板)语义不变。
 *
 * 数据只有一处来源:派工读面 `repo.task.dispatches`,与任务详情「执行与干预」共享
 * 同一 query key,打开预览不多发一套请求、也不另算轮次。收起时不渲染泳道,但读取
 * 仍由 Section 的计数决定是否值得显示入口(空任务不给假展开按钮)。
 */

/** 派工行状态 → 泳道块状态:与总览 agentLanesOf 同一张映射表(词表只在这里解释一次)。 */
const LANE_ACTIVITY_OF_DISPATCH: Readonly<Record<TaskDispatchProjectionRow["status"], AgentLaneTask["status"]>> = {
  running: "running",
  blocked: "awaiting",
  succeeded: "done",
  failed: "failed",
  unknown: "idle",
  cancelled: "idle",
  stopped: "idle",
  lost: "idle",
};

const epochMs = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** 派工行 → 单个任务块(块的 id 是派工 id,不是任务 id;两者分工与总览一致)。 */
function laneTaskOf(row: TaskDispatchProjectionRow, label: string, nowMs: number): AgentLaneTask {
  const startedAt = epochMs(row.startedAt) ?? nowMs,
    endedAt = epochMs(row.endedAt),
    running = row.status === "running";
  return {
    id: row.dispatchId,
    taskId: row.taskId,
    label,
    startAt: startedAt,
    // 已收口或阻塞的块给确定终点;只有运行中的块随 now 生长(与总览同一条纪律)。
    endAt: endedAt ?? (running ? null : nowMs),
    status: LANE_ACTIVITY_OF_DISPATCH[row.status],
  };
}

export function TaskPreviewLanes({ task }: { readonly task: TaskRow }) {
  const [expanded, setExpanded] = useState(false);
  // 只在块缺起止时间时兜底:泳道自己的 now 由 AgentLanes 按运行块每秒推进。
  const nowMs = Date.now();
  const dispatches = useQuery({
    // 与任务详情「执行与干预」同一读键:两个面板共享一次读与缓存失效扇出。
    queryKey: runtimeQueryKeys.dispatches(task.projectId, task.taskId),
    queryFn: () => harnessClient.getTaskDispatches({ repoId: task.projectId, taskId: task.taskId }),
    staleTime: 4_000,
  });
  const rows = dispatches.data?.dispatches ?? [];
  const lane: AgentLane | null =
    rows.length === 0
      ? null
      : {
          agentId: task.taskId,
          role: task.title,
          tasks: rows.map((row, index) =>
            laneTaskOf(row, t("views.execution.roundTitle", { index: index + 1, role: dispatchRole(row) }), nowMs),
          ),
        };

  return (
    <Section
      title={t("components.taskPreviewDrawer.lanes")}
      count={lane === null ? undefined : t("components.taskPreviewDrawer.lanesCount", { count: lane.tasks.length })}
      action={
        lane === null ? undefined : (
          <Button
            variant="ghost"
            size="sm"
            testId="task-preview-lanes-toggle"
            ariaLabel={
              expanded ? t("components.taskPreviewDrawer.lanesCollapse") : t("components.taskPreviewDrawer.lanesExpand")
            }
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <CaretDown aria-hidden /> : <CaretRight aria-hidden />}
            {expanded ? t("components.taskPreviewDrawer.lanesCollapse") : t("components.taskPreviewDrawer.lanesExpand")}
          </Button>
        )
      }
    >
      {dispatches.isPending ? (
        <p className="m-0 animate-pulse text-text-faint ui-meta" data-testid="task-preview-lanes-loading">
          {t("components.taskPreviewDrawer.lanesLoading")}
        </p>
      ) : dispatches.isError ? (
        <p role="alert" className="m-0 text-danger ui-meta" data-testid="task-preview-lanes-error">
          {t("components.taskPreviewDrawer.lanesError", { message: dispatches.error.message })}
        </p>
      ) : lane === null ? (
        <p className="m-0 text-text-faint ui-meta" data-testid="task-preview-lanes-empty">
          {t("components.taskPreviewDrawer.lanesEmpty")}
        </p>
      ) : expanded ? (
        <div data-testid="task-preview-lanes" className="min-w-0">
          <AgentLanes lanes={[lane]} testId="task-preview-lane" />
        </div>
      ) : null}
    </Section>
  );
}
