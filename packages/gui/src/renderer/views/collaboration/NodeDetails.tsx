import { principalLabel } from "../../model/actor-name.ts";
import { Fragment, type ReactNode } from "react";
import { t } from "../../i18n/index.tsx";
import type { FleetFieldState, FleetOverviewNode, FleetOverviewRead } from "../../../api/renderer-dto.ts";
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

export function nodeLabelOf(node: FleetOverviewNode): string {
  return node.role === "center" ? t("collaboration.centerNode") : node.nodeId;
}

export function NodeDetails({
  node,
  overview,
  now,
  onOpenTask,
  onNavigateEntity,
  onClose,
}: {
  readonly node: FleetOverviewNode;
  readonly overview: FleetOverviewRead;
  readonly now: string;
  readonly onOpenTask: (id: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <div data-testid="collaboration-node-details" className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          {/* 长节点 id 在抽屉宽度内换行展示(完整可读),不截断成看不见的省略号。 */}
          <h2 className="break-all font-semibold ui-title" title={nodeLabelOf(node)}>
            {nodeLabelOf(node)}
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
      {node.replica === null ? null : (
        <CutProgress
          ack={node.replica.ackRevision}
          center={node.replica.centerRevision}
          lagRevisions={node.replica.lagRevisions}
        />
      )}
      <DetailBlock title={t("collaboration.doingTitle")}>
        {"redacted" in node.leases ? (
          <p
            data-testid="collaboration-node-leases-redacted"
            data-reason={node.leases.redacted}
            title={node.leases.redacted}
            className="ui-meta text-status-blocked"
          >
            {t("collaboration.noPermission")}：{reasonText(node.leases.redacted)}
          </p>
        ) : node.leases.length === 0 ? (
          <p className="ui-meta text-text-muted">{t("collaboration.noLeases")}</p>
        ) : (
          node.leases.map((lease) => (
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
      <DetailBlock title={t("collaboration.internalTitle")}>
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
        {node.replica === null ? (
          <DetailLine
            label={t("collaboration.fieldReplica")}
            value={node.replicaNote === null ? t("collaboration.notProvided") : reasonText(node.replicaNote)}
            title={node.replicaNote ?? undefined}
          />
        ) : (
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
        <span>{principalLabel(lease.principal)}</span>
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
