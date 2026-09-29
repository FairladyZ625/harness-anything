import { useState } from "react";
import { ArrowSquareOut, CheckCircle, Lock, PushPin, X, XCircle } from "@phosphor-icons/react";
import type { RelationEdge, TaskRow } from "../model/types";
import { isExternal } from "../model/types";
import { normalizeTaskId } from "../model/triadic.ts";
import { CloseoutBadge, EngineBadge, FreshnessTag } from "./badges";
import { StatusTag } from "./primitives/StatusTag";
import { Drawer } from "./primitives/Drawer";
import { t } from "../i18n/index.tsx";
import { EntityRefLink } from "./EntityRefLink.tsx";
import { formatTime } from "../model/time.ts";

const timeOf = (iso: string) => formatTime(iso, { style: "month-day-time" }) ?? "—";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border py-3">
      <div className="mb-2 font-mono text-text-faint uppercase tracking-wide ui-meta">{title}</div>
      {children}
    </section>
  );
}

/**
 * 任务预览:右侧抽屉里的任务实体详情。抽屉壳(定位、Esc、点外面关、进出场)
 * 由 primitives/Drawer 提供;这里只组合任务详情的内容。
 */
export function TaskPreviewDrawer({
  task,
  tasks,
  relations,
  onClose,
  onOpenDetail,
  onPreviewTask,
  onSetPin,
}: {
  task: TaskRow | null;
  tasks: readonly TaskRow[];
  relations: RelationEdge[];
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onPreviewTask: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  // 关闭时保留最后一张卡渲染退出动画;换卡时(taskId 变)同步到最新数据。
  const [shown, setShown] = useState<TaskRow | null>(task);
  if (task !== null && task.taskId !== shown?.taskId) setShown(task);

  return (
    <Drawer
      open={task !== null}
      onClose={onClose}
      modal={false}
      ariaLabel={t("components.taskPreviewDrawer.closeTaskPreview")}
    >
      {shown !== null && (
        <TaskPreviewBody
          task={shown}
          tasks={tasks}
          relations={relations}
          onClose={onClose}
          onOpenDetail={onOpenDetail}
          onPreviewTask={onPreviewTask}
          onSetPin={onSetPin}
        />
      )}
    </Drawer>
  );
}

function TaskPreviewBody({
  task,
  tasks,
  relations,
  onClose,
  onOpenDetail,
  onPreviewTask,
  onSetPin,
}: {
  task: TaskRow;
  tasks: readonly TaskRow[];
  relations: RelationEdge[];
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onPreviewTask: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  const related = relations
    .filter(
      (edge) =>
        (edge.from.startsWith("task/") && normalizeTaskId(edge.from) === task.taskId) ||
        (edge.to.startsWith("task/") && normalizeTaskId(edge.to) === task.taskId),
    )
    .map((edge) => {
      const otherRef = normalizeTaskId(edge.from) === task.taskId ? edge.to : edge.from,
        otherId = otherRef.startsWith("task/") ? normalizeTaskId(otherRef) : "";
      return { edge, task: tasks.find((candidate) => candidate.taskId === otherId) };
    })
    .filter((item) => item.task);
  const missingDocs = task.docs.filter((doc) => doc.required && doc.presence !== "unknown" && !doc.present);
  // 完整渲染,不分批(2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户点击)。
  const orderedEvents = [...(task.events ?? [])].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <header className="border-b border-border pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <EntityRefLink
                entityRef={`task/${task.taskId}`}
                onNavigate={() => onOpenDetail(task.taskId)}
                title={task.taskId}
                className="font-mono text-text-faint hover:text-accent hover:underline ui-body"
              />
              <EngineBadge engine={task.engine} locked={isExternal(task)} />
              {isExternal(task) && (
                <span className="inline-flex items-center gap-1 text-text-faint ui-meta">
                  <Lock weight="bold" />
                  {t("components.taskPreviewDrawer.readOnlySource")}
                </span>
              )}
            </div>
            <h2 className="mt-2 font-semibold leading-tight text-text ui-heading">{task.title}</h2>
          </div>
          {onSetPin && (
            <button
              type="button"
              data-testid="task-preview-pin-toggle"
              onClick={() => onSetPin(task, task.pinned !== true)}
              aria-pressed={task.pinned === true}
              title={task.pinned === true ? t("views.taskDetailView.unpinTitle") : t("views.taskDetailView.pinTitle")}
              className={`grid size-8 shrink-0 place-items-center rounded-md hover:bg-surface-raised ${
                task.pinned === true ? "text-accent" : "text-text-faint hover:text-text"
              }`}
            >
              <PushPin weight={task.pinned === true ? "fill" : "bold"} />
            </button>
          )}
          <button
            onClick={onClose}
            aria-label={t("components.taskPreviewDrawer.closeTaskPreview")}
            className="grid size-8 shrink-0 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusTag status={task.coordinationStatus} />
          {task.coordinationStatus === "blocked" && task.canonicalStatus && (
            <span className="font-mono text-status-blocked ui-micro">
              {t("components.taskPreviewDrawer.canonical")} {task.canonicalStatus}
            </span>
          )}
          {task.blocking === "unknown" && (
            <span className="text-stale ui-micro">{t("components.taskPreviewDrawer.blockingUnknown")}</span>
          )}
          <CloseoutBadge value={task.closeoutReadiness} />
          <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
        </div>
      </header>

      <Section title={t("components.taskPreviewDrawer.context")}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 ui-body">
          <div>
            <dt className="font-mono text-text-faint ui-meta">{t("components.taskPreviewDrawer.rawStatus")}</dt>
            <dd className="font-mono text-text">{task.rawStatus}</dd>
          </div>
          <div>
            <dt className="font-mono text-text-faint ui-meta">{t("components.taskPreviewDrawer.package")}</dt>
            <dd className="font-mono text-text">{task.packageDisposition}</dd>
          </div>
          <div>
            <dt className="font-mono text-text-faint ui-meta">{t("components.taskPreviewDrawer.source")}</dt>
            <dd className="font-mono text-text">{task.origin ?? task.source}</dd>
          </div>
          <div>
            <dt className="font-mono text-text-faint ui-meta">{t("components.taskPreviewDrawer.productLines")}</dt>
            <dd className="font-mono text-text">
              {task.productLines?.join(", ") || t("components.taskPreviewDrawer.notProjected")}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-text-faint ui-meta">{t("components.taskPreviewDrawer.parentRoot")}</dt>
            <dd className="font-mono text-text">
              {task.parentTaskId ? (
                <EntityRefLink
                  entityRef={`task/${task.parentTaskId}`}
                  onNavigate={() => onOpenDetail(task.parentTaskId!)}
                  title={task.parentTaskId}
                  className="text-accent hover:underline"
                />
              ) : (
                "root"
              )}{" "}
              /{" "}
              {task.workId ? (
                <EntityRefLink
                  entityRef={`task/${task.workId}`}
                  onNavigate={() => onOpenDetail(task.workId!)}
                  title={task.workId}
                  className="text-accent hover:underline"
                />
              ) : (
                <EntityRefLink
                  entityRef={`task/${task.taskId}`}
                  onNavigate={() => onOpenDetail(task.taskId)}
                  title={task.taskId}
                  className="text-accent hover:underline"
                />
              )}
            </dd>
          </div>
        </dl>
      </Section>

      <Section title={t("components.taskPreviewDrawer.gates")}>
        {task.gates.length === 0 ? (
          <p className="text-text-faint ui-body">{t("components.taskPreviewDrawer.thereNoGateRecordYet")}</p>
        ) : (
          <div className="space-y-2">
            {task.gates.map((gate) => (
              <div key={gate.name} className="flex items-start gap-2 rounded-md bg-surface-raised px-3 py-2">
                {gate.ok ? (
                  <CheckCircle weight="duotone" className="mt-0.5 shrink-0 text-status-done ui-title" />
                ) : (
                  <XCircle weight="duotone" className="mt-0.5 shrink-0 text-danger ui-title" />
                )}
                <div className="min-w-0">
                  <div className="font-mono text-text ui-body">{gate.name}</div>
                  {gate.detail && (
                    <div className={`mt-0.5 ui-body ${gate.ok ? "text-text-faint" : "text-danger"}`}>{gate.detail}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("components.taskPreviewDrawer.closingMaterial")}>
        {task.docs.length === 0 ? (
          <p className="text-stale ui-body">{t("components.taskPreviewDrawer.documentListUnavailable")}</p>
        ) : missingDocs.length === 0 ? (
          <p className="text-text-muted ui-body">{t("components.taskPreviewDrawer.requiredDocumentationComplete")}</p>
        ) : (
          <div className="space-y-1.5">
            {missingDocs.map((doc) => (
              <div key={doc.path} className="flex items-center gap-2 rounded-md bg-surface-raised px-3 py-2">
                <span className="font-mono text-danger ui-body">
                  {t("components.taskPreviewDrawer.missingDocument")}
                </span>
                <span className="min-w-0 flex-1 truncate ui-body">{doc.title}</span>
                <span className="font-mono text-text-faint ui-meta">{doc.path}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("components.taskPreviewDrawer.associatedTasks")}>
        {related.length === 0 ? (
          <p className="text-text-faint ui-body">{t("components.taskPreviewDrawer.thereCurrentlyNoRelatedEdges")}</p>
        ) : (
          <div className="space-y-1.5">
            {related.map(({ edge, task: relatedTask }) => (
              <button
                key={`${edge.from}-${edge.kind}-${edge.to}`}
                onClick={() => onPreviewTask(relatedTask!.taskId)}
                className="flex w-full items-center gap-2 rounded-md bg-surface-raised px-3 py-2 text-left hover:bg-bg"
              >
                <span className="font-mono text-text-faint ui-meta">{edge.kind}</span>
                <span className="font-mono text-text ui-body">{relatedTask!.taskId}</span>
                <span className="min-w-0 flex-1 truncate text-text-muted ui-body">{relatedTask!.title}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("components.taskPreviewDrawer.recentEvents")}>
        {orderedEvents.length === 0 ? (
          <p className="text-text-faint ui-body">{t("components.taskPreviewDrawer.noEventsYet")}</p>
        ) : (
          <div className="space-y-2">
            {orderedEvents.map((event) => (
              <div
                key={`${event.at}-${event.summary}`}
                className="ui-body [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]"
              >
                <span className="font-mono text-text-faint ui-meta">{timeOf(event.at)}</span>
                <span className="ml-2 text-text-muted">{event.summary}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <footer className="flex items-center gap-2 pt-3">
        <button
          onClick={() => onOpenDetail(task.taskId)}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 font-semibold text-accent-fg ui-prose"
        >
          <ArrowSquareOut weight="bold" />
          {t("components.taskPreviewDrawer.openFullDetails")}
        </button>
        <button
          onClick={onClose}
          className="rounded-md border border-border px-3 py-2 text-text-muted hover:bg-surface-raised hover:text-text ui-prose"
        >
          {t("components.taskPreviewDrawer.close")}
        </button>
      </footer>
    </>
  );
}
