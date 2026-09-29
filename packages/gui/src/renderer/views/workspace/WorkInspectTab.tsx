import { useState } from "react";
import { ResultPagination } from "../../components/ResultPagination.tsx";
import { eventTypeLabel } from "../../model/workspace-readable.ts";
import { formatTime } from "../../model/time.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 检修页(原型 v2):原始事件流只住在这里——排查问题时才看,不作为常规信息展示
 * 给人(标准 §1)。事件是服务端按工作收好的摘要窗,大 payload 不过 RPC 边界。
 */

const WORKSPACE_HISTORY_ROWS = 40;

export interface WorkInspectTabProps {
  /** workspaceEvidenceOf 的成员事件,新事件在前。 */
  readonly events: readonly {
    readonly key: string;
    readonly type: string;
    readonly at: string | null;
    readonly taskId: string | null;
    readonly summary: string | null;
  }[];
  readonly historyComplete: boolean;
  readonly titles: ReadonlyMap<string, string>;
  readonly onNavigateEntity?: (ref: string) => void;
}

export function WorkInspectTab({ events, historyComplete, titles, onNavigateEntity }: WorkInspectTabProps) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(events.length / WORKSPACE_HISTORY_ROWS) - 1));
  const rows = events.slice(currentPage * WORKSPACE_HISTORY_ROWS, (currentPage + 1) * WORKSPACE_HISTORY_ROWS),
    // 「只有索引、没有正文」是整个窗口的一个性质,不是每一行各自的新闻:整段至多说一次。
    anyPayloadLess = rows.some(({ summary }) => summary === null);
  return (
    <div className="min-w-0 max-w-[900px]">
      <p className="mb-3 text-text-muted ui-meta">{t("views.workspace.inspect.lead")}</p>
      <section className="rounded-sm border border-border bg-surface-raised p-4" aria-labelledby="workspace-history">
        <h2 id="workspace-history" className="font-semibold text-text ui-body">
          {t("views.workspace.history")}
        </h2>
        <p className="mt-1 text-text-muted ui-meta">
          {t("views.workspace.eventWindow", {
            mode: "work",
            coverage: t(historyComplete ? "views.workspace.windowComplete" : "views.workspace.windowPartial"),
          })}
        </p>
        {anyPayloadLess ? <p className="mt-1 text-text-muted ui-meta">{t("views.workspace.payloadMissing")}</p> : null}
        {rows.length === 0 ? (
          <p className="mt-3 text-text-muted ui-body">{t("views.workspace.historyEmpty")}</p>
        ) : (
          <ol className="mt-3">
            {rows.map((event, index) => {
              const taskRef = event.taskId === null ? null : `task/${event.taskId}`,
                // 标题在读面里就用标题,没有就如实退回原始 task id——不猜。
                taskName = (taskRef === null ? undefined : titles.get(taskRef)) ?? event.taskId,
                day = event.at ? formatTime(event.at, { style: "date" }) : null,
                previousAt = rows[index - 1]?.at,
                previousDay = previousAt ? formatTime(previousAt, { style: "date" }) : null;
              return (
                <li key={event.key} className="min-w-0">
                  {index === 0 || day !== previousDay ? (
                    <p className="border-b border-border py-2 font-semibold text-text-muted ui-meta">
                      {day ?? t("views.workspace.timeMissing")}
                    </p>
                  ) : null}
                  <div className="flex items-baseline gap-3 border-b border-border/50 py-1.5">
                    <time className="shrink-0 font-mono text-text-muted ui-meta">
                      {event.at ? formatTime(event.at, { style: "month-day-time" }) : "—"}
                    </time>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        title={`${event.type} · ${event.taskId ?? ""}`}
                        className="block w-full break-words text-left text-text ui-body"
                        onClick={() => taskRef !== null && onNavigateEntity?.(taskRef)}
                      >
                        <span className="font-medium">{eventTypeLabel(event.type)}</span>
                        <span className="text-text-muted"> · {taskName ?? t("views.workspace.entityMissing")}</span>
                      </button>
                      {event.summary === null ? null : (
                        <details className="text-text-muted ui-meta">
                          <summary className="cursor-pointer">查看记录摘要</summary>
                          <p className="break-words py-1 text-sm">{event.summary}</p>
                        </details>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <ResultPagination
          label={t("views.workspace.history")}
          page={currentPage}
          total={events.length}
          size={WORKSPACE_HISTORY_ROWS}
          onChange={setPage}
        />
      </section>
    </div>
  );
}
