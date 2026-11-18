import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n/index.tsx";
import type { FleetFieldState, FleetOverviewNode, FleetOverviewRead } from "../../../api/renderer-dto.ts";
import type { FleetNodeUnregisterInput } from "../../../api/fleet-admin-contract.ts";
import { formatNodeDisplay, personShortName } from "../../model/attribution.ts";
import { formatListTime } from "../../model/time.ts";
import { EntityRefLink } from "../../components/EntityRefLink.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import {
  fieldText,
  machineOf,
  noteLabel,
  PHASE_LABEL,
  PHASE_TONE,
  reasonText,
  type FleetLeaseRowView,
} from "./fleet-labels.ts";

/**
 * 节点详情抽屉的内容(协作页视觉重做,task_16c20131):壳是共享 Drawer 原语(右侧
 * 滑入、Esc 关闭、非模态),这里只组合内容——「在做什么」租约分区、「内部状态」
 * 三态字段分区,cut 用细进度条(ack/center)、lag 用数字+小柱;未提供字段灰显并
 * 带人话原因,机器码只进 title/data-reason(契约与数据层 task_8ce646d94 一致)。
 */

export function nodeLabelOf(node: FleetOverviewNode, peopleById?: ReadonlyMap<string, string>): string {
  if (node.role === "center") return t("collaboration.centerNode");
  const ownerPersonId = node.owner.kind === "value" ? node.owner.text : null;
  return formatNodeDisplay(node.nodeId, ownerPersonId, { peopleById });
}

type UnregisterState =
  | { readonly step: "idle" }
  | { readonly step: "previewing" }
  | { readonly step: "preview_error"; readonly error: string }
  | {
      readonly step: "confirming" | "submitting";
      readonly targetRepoId: string;
      readonly targetActorPersonId: string | null;
      readonly targetNodeId: string;
      readonly expectedVersion: string;
      readonly busy: boolean;
      readonly force: boolean;
      readonly error: string | null;
    }
  | { readonly step: "done" };

function failureFromReply(reply: Record<string, unknown>, fallback: string): { code?: string; message: string } | null {
  if (reply.ok !== false && typeof reply.code !== "string") return null;
  if (reply.ok === true) return null;
  const code = typeof reply.code === "string" ? reply.code : undefined;
  const message = (typeof reply.message === "string" && reply.message) || code || fallback;
  return { code, message };
}

function failureFromError(error: unknown): { code?: string; message: string } {
  const code =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

export function NodeDetails({
  repoId = "",
  actorPersonId = null,
  node,
  overview,
  now,
  onOpenTask,
  onNavigateEntity,
  onClose,
  canManageFleetNodes = false,
  peopleById,
  onOpenNodeBoard,
  onOpenNodeSessions,
  onUnregisterNode,
}: {
  readonly repoId?: string;
  readonly actorPersonId?: string | null;
  readonly node: FleetOverviewNode;
  readonly overview: FleetOverviewRead;
  readonly now: string;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onClose: () => void;
  readonly canManageFleetNodes?: boolean;
  readonly peopleById?: ReadonlyMap<string, string>;
  readonly onOpenNodeBoard?: (nodeId: string) => void;
  readonly onOpenNodeSessions?: (nodeId: string) => void;
  readonly onUnregisterNode?: (input: FleetNodeUnregisterInput) => Promise<Record<string, unknown>>;
}) {
  const assignments = node.leases;
  const label = nodeLabelOf(node, peopleById);
  const [unregisterState, setUnregisterState] = useState<UnregisterState>({ step: "idle" });
  const contextKey = `${repoId}\0${actorPersonId ?? ""}\0${node.nodeId}`;
  const contextRef = useRef(contextKey);
  const opSeqRef = useRef(0);
  contextRef.current = contextKey;

  useEffect(() => {
    opSeqRef.current += 1;
    setUnregisterState({ step: "idle" });
  }, [contextKey]);

  useEffect(() => {
    if (!canManageFleetNodes) {
      opSeqRef.current += 1;
      setUnregisterState({ step: "idle" });
    }
  }, [canManageFleetNodes]);

  const startUnregister = () => {
    if (!canManageFleetNodes || !onUnregisterNode || node.role !== "edge") return;
    const requestContext = contextKey;
    const targetRepoId = repoId;
    const targetActorPersonId = actorPersonId;
    const targetNodeId = node.nodeId;
    const seq = ++opSeqRef.current;
    setUnregisterState({ step: "previewing" });
    void onUnregisterNode({ nodeId: targetNodeId }).then(
      (reply) => {
        if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
        const failure = failureFromReply(reply, "unregister preview failed");
        if (failure) {
          setUnregisterState({
            step: "preview_error",
            error: t("collaboration.unregisterPreviewFailed", { error: failure.message }),
          });
          return;
        }
        const expectedVersion = typeof reply.expectedVersion === "string" ? reply.expectedVersion.trim() : "";
        if (!expectedVersion) {
          setUnregisterState({
            step: "preview_error",
            error: t("collaboration.unregisterPreviewFailed", { error: "missing expectedVersion" }),
          });
          return;
        }
        const inFlightBusy =
          typeof reply.inFlight === "number"
            ? reply.inFlight > 0
            : Array.isArray(reply.inFlight)
              ? reply.inFlight.length > 0
              : reply.inFlight === true;
        const busy =
          reply.online === true ||
          inFlightBusy ||
          (Array.isArray(reply.leases) && reply.leases.length > 0) ||
          (typeof reply.leases === "number" && reply.leases > 0) ||
          (Array.isArray(reply.executions) && reply.executions.length > 0) ||
          (typeof reply.executions === "number" && reply.executions > 0);
        setUnregisterState({
          step: "confirming",
          targetRepoId,
          targetActorPersonId,
          targetNodeId,
          expectedVersion,
          busy,
          force: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
        const failure = failureFromError(error);
        setUnregisterState({
          step: "preview_error",
          error: t("collaboration.unregisterPreviewFailed", { error: failure.message }),
        });
      },
    );
  };

  const confirmUnregister = () => {
    if (!canManageFleetNodes || !onUnregisterNode || unregisterState.step !== "confirming") return;
    const current = unregisterState;
    if (
      current.targetNodeId !== node.nodeId ||
      current.targetRepoId !== repoId ||
      current.targetActorPersonId !== actorPersonId
    ) {
      opSeqRef.current += 1;
      setUnregisterState({ step: "idle" });
      return;
    }
    const requestContext = contextKey;
    const seq = ++opSeqRef.current;
    setUnregisterState({ ...current, step: "submitting", error: null });
    const handleConfirmFailure = (failure: { code?: string; message: string }) => {
      if (failure.code === "version_conflict") {
        setUnregisterState({
          step: "preview_error",
          error: t("collaboration.unregisterVersionConflict"),
        });
        return;
      }
      setUnregisterState({
        ...current,
        step: "confirming",
        busy: current.busy || failure.code === "node_busy",
        error: failure.message,
      });
    };
    void onUnregisterNode({
      nodeId: current.targetNodeId,
      expectedVersion: current.expectedVersion,
      confirm: true,
      ...(current.force ? { force: true } : {}),
    }).then(
      (reply) => {
        if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
        const failure = failureFromReply(reply, "unregister failed");
        if (failure) {
          handleConfirmFailure(failure);
          return;
        }
        setUnregisterState({ step: "done" });
      },
      (error: unknown) => {
        if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
        handleConfirmFailure(failureFromError(error));
      },
    );
  };

  return (
    <div data-testid="collaboration-node-details" className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          {/* 可读节点名，完整 nodeId 在 title 悬停保留。 */}
          <h2 className="break-all font-semibold ui-title" title={node.nodeId}>
            {label}
          </h2>
          <p className="mt-0.5 ui-micro text-text-faint">{t("collaboration.nodeDetailNote")}</p>
        </div>
        <button
          type="button"
          data-testid="collaboration-node-details-close"
          onClick={onClose}
          className="shrink-0 text-accent ui-meta"
        >
          {t("collaboration.close")}
        </button>
      </header>
      {(onOpenNodeBoard || onOpenNodeSessions || (canManageFleetNodes && node.role === "edge" && onUnregisterNode)) && (
        <div className="flex flex-wrap items-center gap-2">
          {onOpenNodeBoard && (
            <button
              type="button"
              data-testid="collaboration-node-open-board"
              onClick={() => onOpenNodeBoard(node.nodeId)}
              className="rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-accent hover:border-border-strong"
            >
              {t("collaboration.openInBoard")}
            </button>
          )}
          {onOpenNodeSessions && (
            <button
              type="button"
              data-testid="collaboration-node-open-sessions"
              onClick={() => onOpenNodeSessions(node.nodeId)}
              className="rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-accent hover:border-border-strong"
            >
              {t("collaboration.openInSessions")}
            </button>
          )}
          {canManageFleetNodes && node.role === "edge" && onUnregisterNode && unregisterState.step === "idle" && (
            <button
              type="button"
              data-testid="collaboration-node-unregister"
              onClick={() => void startUnregister()}
              className="ml-auto rounded border border-status-blocked/50 bg-status-blocked/10 px-2 py-1 ui-meta text-status-blocked hover:bg-status-blocked/20"
            >
              {t("collaboration.unregisterNode")}
            </button>
          )}
        </div>
      )}
      {unregisterState.step !== "idle" && (
        <div
          data-testid="collaboration-unregister-panel"
          className="rounded border border-status-blocked/40 bg-status-blocked/5 p-3 ui-meta"
        >
          {unregisterState.step === "previewing" ? (
            <p className="text-text-muted">{t("collaboration.unregisterPreviewing")}</p>
          ) : unregisterState.step === "preview_error" ? (
            <div className="flex flex-col gap-2">
              <p role="alert" data-testid="collaboration-unregister-error" className="ui-micro text-status-blocked">
                {unregisterState.error}
              </p>
              <div className="flex items-center gap-2 pt-1">
                {canManageFleetNodes && node.role === "edge" && onUnregisterNode && (
                  <button
                    type="button"
                    data-testid="collaboration-unregister-retry"
                    onClick={() => void startUnregister()}
                    className="rounded border border-border bg-surface px-2.5 py-1 ui-meta text-text hover:border-border-strong"
                  >
                    {t("collaboration.unregisterRetryPreview")}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="collaboration-unregister-cancel"
                  onClick={() => setUnregisterState({ step: "idle" })}
                  className="rounded border border-border bg-surface px-2.5 py-1 ui-meta text-text-muted hover:text-text"
                >
                  {t("collaboration.unregisterCancel")}
                </button>
              </div>
            </div>
          ) : unregisterState.step === "done" ? (
            <p role="status" data-testid="collaboration-unregister-succeeded" className="text-status-done">
              {t("collaboration.unregisterSucceeded", { label })}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-text">{t("collaboration.unregisterWarning", { label })}</p>
              {unregisterState.busy && (
                <div className="flex flex-col gap-1.5">
                  <p className="ui-micro text-status-blocked">{t("collaboration.unregisterBusy")}</p>
                  <label className="flex items-center gap-1.5 ui-micro text-text">
                    <input
                      type="checkbox"
                      data-testid="collaboration-unregister-force"
                      checked={unregisterState.force}
                      onChange={(event) =>
                        setUnregisterState({
                          ...unregisterState,
                          force: event.target.checked,
                        })
                      }
                    />
                    <span>{t("collaboration.unregisterForce")}</span>
                  </label>
                </div>
              )}
              {unregisterState.error && (
                <p role="alert" data-testid="collaboration-unregister-error" className="ui-micro text-status-blocked">
                  {unregisterState.error}
                </p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  data-testid="collaboration-unregister-confirm"
                  disabled={unregisterState.step === "submitting"}
                  onClick={() => void confirmUnregister()}
                  className="rounded border border-status-blocked bg-status-blocked px-2.5 py-1 ui-meta font-medium text-surface disabled:opacity-60"
                >
                  {t("collaboration.unregisterConfirm", { label })}
                </button>
                <button
                  type="button"
                  data-testid="collaboration-unregister-cancel"
                  disabled={unregisterState.step === "submitting"}
                  onClick={() => setUnregisterState({ step: "idle" })}
                  className="rounded border border-border bg-surface px-2.5 py-1 ui-meta text-text-muted hover:text-text"
                >
                  {t("collaboration.unregisterCancel")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {node.replica === null ? null : (
        <CutProgress
          ack={node.replica.ackRevision}
          center={node.replica.centerRevision}
          lagRevisions={node.replica.lagRevisions}
        />
      )}
      <DetailBlock title={t("collaboration.doingTitle")}>
        {"redacted" in assignments ? (
          <p
            data-testid="collaboration-node-leases-redacted"
            data-reason={assignments.redacted}
            title={assignments.redacted}
            className="ui-meta text-status-blocked"
          >
            {t("collaboration.noPermission")}：{reasonText(assignments.redacted)}
          </p>
        ) : assignments.length === 0 ? (
          <p className="ui-meta text-text-muted">{t("collaboration.noLeases")}</p>
        ) : (
          assignments.map((lease) => (
            <LeaseRow
              key={lease.taskId}
              lease={lease}
              now={now}
              onOpenTask={onOpenTask}
              onNavigateEntity={onNavigateEntity}
            />
          ))
        )}
      </DetailBlock>
      {node.recentTasks !== undefined && (
        <DetailBlock title={t("collaboration.recentTasksTitle")}>
          {"redacted" in node.recentTasks ? (
            <p
              data-testid="collaboration-node-recent-tasks-redacted"
              data-reason={node.recentTasks.redacted}
              className="ui-meta text-status-blocked"
            >
              {t("collaboration.noPermission")}：{reasonText(node.recentTasks.redacted)}
            </p>
          ) : node.recentTasks.length === 0 ? (
            <p className="ui-meta text-text-muted">{t("collaboration.noRecentTasks")}</p>
          ) : (
            node.recentTasks.map((task) => (
              <div key={task.taskId} className="border-t border-border py-1.5 first:border-t-0">
                <div className="flex items-center gap-2">
                  <StatusTag mono tone="neutral" label={task.coordinationStatus} />
                  <button
                    type="button"
                    data-testid={`collaboration-recent-task-${task.taskId}`}
                    onClick={() => onOpenTask(task.taskId)}
                    className="min-w-0 flex-1 truncate text-left ui-body hover:underline"
                    title={task.taskId}
                  >
                    {task.title ?? task.taskId}
                  </button>
                  <span className="shrink-0 ui-micro text-text-faint">{formatListTime(task.updatedAt, { now })}</span>
                </div>
                {task.personId && (
                  <div className="mt-0.5 ui-micro text-text-muted">{personShortName(task.personId, peopleById)}</div>
                )}
              </div>
            ))
          )}
        </DetailBlock>
      )}
      {node.recentDispatches !== undefined && (
        <DetailBlock title={t("collaboration.recentDispatchesTitle")}>
          {"redacted" in node.recentDispatches ? (
            <p
              data-testid="collaboration-node-recent-dispatches-redacted"
              data-reason={node.recentDispatches.redacted}
              className="ui-meta text-status-blocked"
            >
              {t("collaboration.noPermission")}：{reasonText(node.recentDispatches.redacted)}
            </p>
          ) : node.recentDispatches.length === 0 ? (
            <p className="ui-meta text-text-muted">{t("collaboration.noRecentDispatches")}</p>
          ) : (
            node.recentDispatches.map((dispatch) => (
              <div key={dispatch.dispatchId} className="border-t border-border py-1.5 first:border-t-0">
                <div className="flex items-center gap-2">
                  <StatusTag mono tone="neutral" label={dispatch.status} />
                  <button
                    type="button"
                    data-testid={`collaboration-recent-dispatch-${dispatch.dispatchId}`}
                    onClick={() => onNavigateEntity(`session/${dispatch.runtimeSessionId}`)}
                    className="min-w-0 flex-1 truncate text-left ui-body hover:underline"
                    title={dispatch.runtimeSessionId}
                  >
                    {dispatch.agentLabel ?? dispatch.agentId ?? dispatch.dispatchId}
                    {(dispatch.taskTitle ?? dispatch.taskId) ? ` · ${dispatch.taskTitle ?? dispatch.taskId}` : ""}
                  </button>
                  <span className="shrink-0 ui-micro text-text-faint">
                    {formatListTime(dispatch.startedAt, { now })}
                  </span>
                </div>
                {dispatch.personId && (
                  <div className="mt-0.5 ui-micro text-text-muted">
                    {personShortName(dispatch.personId, peopleById)}
                  </div>
                )}
              </div>
            ))
          )}
        </DetailBlock>
      )}
      {node.recentEvents !== undefined && (
        <DetailBlock title={t("collaboration.recentEventsTitle")}>
          {"redacted" in node.recentEvents ? (
            <p
              data-testid="collaboration-node-recent-events-redacted"
              data-reason={node.recentEvents.redacted}
              className="ui-meta text-status-blocked"
            >
              {t("collaboration.noPermission")}：{reasonText(node.recentEvents.redacted)}
            </p>
          ) : node.recentEvents.length === 0 ? (
            <p className="ui-meta text-text-muted">{t("collaboration.noRecentEvents")}</p>
          ) : (
            node.recentEvents.map((event) => (
              <div
                key={event.eventId}
                data-testid={`collaboration-recent-event-${event.eventId}`}
                className="flex items-center gap-2 border-t border-border py-1.5 ui-meta first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate text-text">
                  {event.type}
                  {event.title ? ` · ${event.title}` : ""}
                </span>
                {event.taskId && (
                  <button
                    type="button"
                    onClick={() => onOpenTask(event.taskId!)}
                    className="shrink-0 font-mono ui-micro text-accent hover:underline"
                    title={event.taskId}
                  >
                    {event.taskId}
                  </button>
                )}
                <span className="shrink-0 ui-micro text-text-faint">{formatListTime(event.occurredAt, { now })}</span>
              </div>
            ))
          )}
        </DetailBlock>
      )}
      <DetailBlock title={t("collaboration.internalTitle")}>
        <DetailLine
          label={t("collaboration.fieldReason")}
          value={reasonText(node.replicaReason)}
          title={node.replicaReason}
        />
        <FieldLine
          label={t("collaboration.fieldDaemon")}
          state={
            node.role === "center"
              ? {
                  kind: "value",
                  text: `${overview.center.daemonId} · ${overview.center.version} @ ${overview.center.commitSha ?? "unknown"}`,
                }
              : node.build
          }
        />
        <FieldLine label={t("collaboration.fieldOwner")} state={node.owner} />
        <FieldLine label={t("collaboration.fieldOnline")} state={node.online} />
        {node.replica === null ? null : (
          <>
            <DetailLine label={t("collaboration.fieldView")} value={`${node.replica.viewId}`} />
            <DetailLine
              label={t("collaboration.fieldCut")}
              value={`${node.replica.ackRevision ?? "—"} / ${node.replica.centerRevision}`}
            />
            <DetailLine
              label={t("collaboration.fieldAck")}
              value={
                node.replica.ackedAt === null
                  ? t("collaboration.notProvided")
                  : formatListTime(node.replica.ackedAt, { now })
              }
            />
            <DetailLine
              label={t("collaboration.fieldLag")}
              value={`rev ${node.replica.lagRevisions}${node.replica.lagMs === null ? "" : ` · ${Math.round(node.replica.lagMs / 1000)}s`} · ${node.replica.delivery}`}
            />
          </>
        )}
        <FieldLine label={t("collaboration.fieldWatch")} state={node.watch} />
        <FieldLine label={t("collaboration.fieldLastFailure")} state={node.lastFailure} />
      </DetailBlock>
      {overview.notes.length > 0 ? (
        <p className="ui-micro text-text-faint" data-testid="collaboration-read-notes">
          {overview.notes.map((note, index) => (
            <Fragment key={note}>
              {index > 0 ? " · " : null}
              <span title={note}>{noteLabel(note)}</span>
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** cut 细进度条(ack/center)+ lag 数字小柱;值域全部来自 daemon DTO,不做推断。 */
function CutProgress({
  ack,
  center,
  lagRevisions,
}: {
  readonly ack: number | null;
  readonly center: number;
  readonly lagRevisions: number;
}) {
  const cutPercent = center > 0 ? Math.round(((ack ?? 0) / center) * 100) : 0;
  // lag 柱的满格是 8 个修订:更深的落后贴满格,由数字给精确值。
  const lagPercent = Math.min(lagRevisions, 8) * 12.5;
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
      <span className="font-mono ui-micro text-text-muted">
        {t("collaboration.cutProgressAria", { ack: ack ?? "—", center })}
      </span>
      <div
        data-testid="collaboration-cut-progress"
        role="progressbar"
        aria-label={t("collaboration.fieldCut")}
        aria-valuemin={0}
        aria-valuemax={center}
        aria-valuenow={ack ?? 0}
        className="h-1 overflow-hidden rounded-full bg-surface-raised"
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${cutPercent}%` }} />
      </div>
      <span className="font-mono ui-micro text-text-muted">{t("collaboration.lagBarAria", { rev: lagRevisions })}</span>
      <div
        data-testid="collaboration-lag-bar"
        role="progressbar"
        aria-label={t("collaboration.fieldLag")}
        aria-valuemin={0}
        aria-valuemax={8}
        aria-valuenow={lagRevisions}
        className="h-1 overflow-hidden rounded-full bg-surface-raised"
      >
        <div
          className={`h-full rounded-full ${lagRevisions > 0 ? "bg-status-submitted" : "bg-status-done"}`}
          style={{ width: `${lagPercent}%` }}
        />
      </div>
    </div>
  );
}

function LeaseRow({
  lease,
  now,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly lease: FleetLeaseRowView;
  readonly now: string;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  return (
    <article className="border-t border-border py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <StatusTag mono tone="neutral" label={lease.coordinationStatus} />
        <button
          type="button"
          data-testid={`collaboration-task-${lease.taskId}`}
          onClick={() => onOpenTask(lease.taskId)}
          className="min-w-0 flex-1 truncate text-left ui-body hover:underline"
        >
          {lease.title ?? lease.taskId}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 ui-micro text-text-muted">
        <span>{lease.personId ?? t("collaboration.notProvided")}</span>
        {lease.agentId === null ? null : (
          <EntityRefLink entityRef={`agent/${lease.agentId}`} onNavigate={onNavigateEntity}>
            {lease.agentLabel ?? lease.agentId}
          </EntityRefLink>
        )}
        {lease.runtimeSessionId === null ? null : (
          <EntityRefLink
            entityRef={`session/${lease.runtimeSessionId}`}
            onNavigate={onNavigateEntity}
            title={lease.runtimeSessionId}
          >
            session
          </EntityRefLink>
        )}
        <span>
          {lease.phase === null ? (
            t("collaboration.leasePhaseMissing")
          ) : (
            <StatusTag
              mono
              tone={PHASE_TONE[lease.phase] ?? "neutral"}
              label={PHASE_LABEL[lease.phase] ? t(PHASE_LABEL[lease.phase]) : lease.phase}
            />
          )}
        </span>
        {lease.startedAt === null ? null : (
          <span>{t("collaboration.dispatchStartedAt", { at: formatListTime(lease.startedAt, { now }) })}</span>
        )}
        {lease.dispatchStatus === null ? null : <span className="font-mono">{lease.dispatchStatus}</span>}
      </div>
    </article>
  );
}

function DetailBlock({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold ui-body">{title}</h3>
      {children}
    </div>
  );
}

/** 三态字段行:有值 / 无权限查看(带原因) / 未提供(带原因)——标签保留,值不编造;
 * 可见文本是人话解释,机器码只进 title/data-reason 供测试断言。值一侧允许收窄与
 * 断词(min-w-0 + break-words):长 id / 长说明必须在抽屉宽度内换行,不许横向溢出。 */
function FieldLine({ label, state }: { readonly label: string; readonly state: FleetFieldState }) {
  const machine = machineOf(state);
  const unavailable = state.kind === "unavailable" || state.kind === "redacted";
  return (
    <div
      className="flex justify-between gap-3 border-t border-border py-1.5 ui-meta"
      data-testid="collaboration-field-line"
    >
      <span className="shrink-0 text-text-faint">{label}</span>
      <span
        className={`min-w-0 break-words text-right ${unavailable ? "text-text-faint" : "text-text-muted"}`}
        data-reason={machine}
        title={machine}
      >
        {fieldText(state)}
        {unavailable ? <span className="block ui-micro text-text-faint">{reasonText(state.reason)}</span> : null}
      </span>
    </div>
  );
}

function DetailLine({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}) {
  return (
    <div className="flex justify-between gap-3 border-t border-border py-1.5 ui-meta" data-reason={title}>
      <span className="shrink-0 text-text-faint">{label}</span>
      <span className="min-w-0 break-words text-right text-text-muted" title={title}>
        {value}
      </span>
    </div>
  );
}
