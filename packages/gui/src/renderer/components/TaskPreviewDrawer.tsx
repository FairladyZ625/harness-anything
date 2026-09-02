import { useEffect } from "react";
import { ArrowSquareOut, CheckCircle, Lock, PushPin, X, XCircle } from "@phosphor-icons/react";
import type { RelationEdge, TaskRow } from "../model/types";
import { isExternal } from "../model/types";
import { normalizeTaskId } from "../model/triadic.ts";
import { CloseoutBadge, EngineBadge, FreshnessTag, StatusBadge } from "./badges";
import { t } from "../i18n/index.tsx";
import { EntityRefLink } from "./EntityRefLink.tsx";
import { formatTime } from "../model/time.ts";

const timeOf = (iso: string) => formatTime(iso, { style: "month-day-time" }) ?? "—";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 font-mono ui-meta uppercase tracking-wide text-text-faint">{title}</div>
      {children}
    </section>
  );
}

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
  useEffect(() => {
    if (!task) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, task]);
  if (!task) return null;

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
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/45">
      <aside className="flex h-full w-full max-w-[520px] flex-col border-l border-border-strong bg-surface shadow-2xl shadow-black/40">
        <header className="border-b border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <EntityRefLink
                  entityRef={`task/${task.taskId}`}
                  onNavigate={() => onOpenDetail(task.taskId)}
                  title={task.taskId}
                  className="font-mono ui-body text-text-faint hover:text-accent hover:underline"
                />
                <EngineBadge engine={task.engine} locked={isExternal(task)} />
                {isExternal(task) && (
                  <span className="inline-flex items-center gap-1 ui-meta text-text-faint">
                    <Lock weight="bold" />
                    {t("components.taskPreviewDrawer.readOnlySource")}
                  </span>
                )}
              </div>
              <h2 className="mt-2 ui-heading font-semibold leading-tight text-text">{task.title}</h2>
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
            <StatusBadge status={task.coordinationStatus} />
            {task.coordinationStatus === "blocked" && task.canonicalStatus && (
              <span className="font-mono ui-micro text-status-blocked">
                {t("components.taskPreviewDrawer.canonical")} {task.canonicalStatus}
              </span>
            )}
            {task.blocking === "unknown" && (
              <span className="ui-micro text-stale">{t("components.taskPreviewDrawer.blockingUnknown")}</span>
            )}
            <CloseoutBadge value={task.closeoutReadiness} />
            <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title={t("components.taskPreviewDrawer.context")}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 ui-body">
              <div>
                <dt className="font-mono ui-meta text-text-faint">{t("components.taskPreviewDrawer.module")}</dt>
                <dd className="font-mono text-text">
                  {task.module === "unassigned" || !task.module
                    ? t("components.taskPreviewDrawer.notProjected")
                    : task.module}
                </dd>
              </div>
              <div>
                <dt className="font-mono ui-meta text-text-faint">{t("components.taskPreviewDrawer.rawStatus")}</dt>
                <dd className="font-mono text-text">{task.rawStatus}</dd>
              </div>
              <div>
                <dt className="font-mono ui-meta text-text-faint">{t("components.taskPreviewDrawer.package")}</dt>
                <dd className="font-mono text-text">{task.packageDisposition}</dd>
              </div>
              <div>
                <dt className="font-mono ui-meta text-text-faint">{t("components.taskPreviewDrawer.source")}</dt>
                <dd className="font-mono text-text">{task.origin ?? task.source}</dd>
              </div>
              <div>
                <dt className="font-mono ui-meta text-text-faint">{t("components.taskPreviewDrawer.productLines")}</dt>
                <dd className="font-mono text-text">
                  {task.productLines?.join(", ") || t("components.taskPreviewDrawer.notProjected")}
                </dd>
              </div>
              <div>
                <dt className="font-mono ui-meta text-text-faint">{t("components.taskPreviewDrawer.parentRoot")}</dt>
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
                  {task.rootTaskId ? (
                    <EntityRefLink
                      entityRef={`task/${task.rootTaskId}`}
                      onNavigate={() => onOpenDetail(task.rootTaskId!)}
                      title={task.rootTaskId}
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
              <p className="ui-body text-text-faint">{t("components.taskPreviewDrawer.thereNoGateRecordYet")}</p>
            ) : (
              <div className="space-y-2">
                {task.gates.map((gate) => (
                  <div key={gate.name} className="flex items-start gap-2 rounded-md bg-surface-raised px-3 py-2">
                    {gate.ok ? (
                      <CheckCircle weight="duotone" className="mt-0.5 shrink-0 ui-title text-status-done" />
                    ) : (
                      <XCircle weight="duotone" className="mt-0.5 shrink-0 ui-title text-danger" />
                    )}
                    <div className="min-w-0">
                      <div className="font-mono ui-body text-text">{gate.name}</div>
                      {gate.detail && (
                        <div className={`mt-0.5 ui-body ${gate.ok ? "text-text-faint" : "text-danger"}`}>
                          {gate.detail}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={t("components.taskPreviewDrawer.closingMaterial")}>
            {task.docs.length === 0 ? (
              <p className="ui-body text-stale">{t("components.taskPreviewDrawer.documentListUnavailable")}</p>
            ) : missingDocs.length === 0 ? (
              <p className="ui-body text-text-muted">
                {t("components.taskPreviewDrawer.requiredDocumentationComplete")}
              </p>
            ) : (
              <div className="space-y-1.5">
                {missingDocs.map((doc) => (
                  <div key={doc.path} className="flex items-center gap-2 rounded-md bg-surface-raised px-3 py-2">
                    <span className="font-mono ui-body text-danger">
                      {t("components.taskPreviewDrawer.missingDocument")}
                    </span>
                    <span className="min-w-0 flex-1 truncate ui-body">{doc.title}</span>
                    <span className="font-mono ui-meta text-text-faint">{doc.path}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={t("components.taskPreviewDrawer.associatedTasks")}>
            {related.length === 0 ? (
              <p className="ui-body text-text-faint">
                {t("components.taskPreviewDrawer.thereCurrentlyNoRelatedEdges")}
              </p>
            ) : (
              <div className="space-y-1.5">
                {related.map(({ edge, task: relatedTask }) => (
                  <button
                    key={`${edge.from}-${edge.kind}-${edge.to}`}
                    onClick={() => onPreviewTask(relatedTask!.taskId)}
                    className="flex w-full items-center gap-2 rounded-md bg-surface-raised px-3 py-2 text-left hover:bg-bg"
                  >
                    <span className="font-mono ui-meta text-text-faint">{edge.kind}</span>
                    <span className="font-mono ui-body text-text">{relatedTask!.taskId}</span>
                    <span className="min-w-0 flex-1 truncate ui-body text-text-muted">{relatedTask!.title}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title={t("components.taskPreviewDrawer.recentEvents")}>
            {orderedEvents.length === 0 ? (
              <p className="ui-body text-text-faint">{t("components.taskPreviewDrawer.noEventsYet")}</p>
            ) : (
              <div className="space-y-2">
                {orderedEvents.map((event) => (
                  <div
                    key={`${event.at}-${event.summary}`}
                    className="ui-body [contain-intrinsic-size:auto_1.25rem] [content-visibility:auto]"
                  >
                    <span className="font-mono ui-meta text-text-faint">{timeOf(event.at)}</span>
                    <span className="ml-2 text-text-muted">{event.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => onOpenDetail(task.taskId)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 ui-prose font-semibold text-accent-fg"
          >
            <ArrowSquareOut weight="bold" />
            {t("components.taskPreviewDrawer.openFullDetails")}
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-2 ui-prose text-text-muted hover:bg-surface-raised hover:text-text"
          >
            {t("components.taskPreviewDrawer.close")}
          </button>
        </footer>
      </aside>
    </div>
  );
}
