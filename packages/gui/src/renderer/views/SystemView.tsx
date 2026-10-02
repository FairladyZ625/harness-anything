import { useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { controlSucceeded, useDaemonControl, useSystemStatusQuery } from "../system-data.ts";
import { DaemonTailPane, type ObserveLogKind } from "../components/observe/DaemonTailPane.tsx";
import type { SystemRepoRow } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { formatDuration, formatTime } from "../model/time.ts";
import { RepoModeBadge } from "../components/RepoModeBadge.tsx";
import { IdText } from "../components/IdText.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { repoCellMeta, repoNeedsAttention } from "../model/repo-state.ts";

/**
 * System 面板:面向使用者的守护进程状态 + 本地仓库表。
 *
 * 版式按标准 §2.5 统计类:先给一行结论(守护进程在跑、N/M 仓已附着、异常数、队列
 * 深度、最近观测),字段明细与仓库表在下;仓库状态用有底色的 StatusTag,异常仓
 * 置顶。字段口径与 archive 线 SystemStatusPanel 对齐(版本/运行时长/PID/端点/守护
 * 进程 ID/用户根目录/队列深度/仓库数 + 仓库表)。连接数(活跃/总计)与全局队列深度
 * 在 gui-system-status/v1 契约里没有投影,呈现为「—」并在 title 说明,不伪造。
 * 机器值(generation 序号、recovery 毫秒)保留为次级行,不再作为唯一呈现。
 */

const dash = () => t("views.settingsView.systemUnknownDash");
const dateTime = (iso: string) => formatTime(iso, { style: "date-time-seconds" }) ?? dash();
const uptime = (uptimeMs: number | undefined): string => formatDuration(uptimeMs, dash());

function Field({ name, value, title }: { readonly name: string; readonly value: string; readonly title?: string }) {
  return (
    <div>
      <dt className="font-mono ui-micro uppercase text-text-faint">{name}</dt>
      <dd className="break-all font-mono ui-meta text-text-muted" title={title}>
        {value}
      </dd>
    </div>
  );
}

/**
 * `observe.tail` 是 requiresRepo 的读面,守护进程自己的日志也要借一个已挂载仓做路由。
 * 系统页优先借当前仓,否则借任一已挂载仓;一个都没有时返回 null,
 * 由调用方显式说明为何读不到。
 */
export function observeRouteRepoId(
  repos: ReadonlyArray<Pick<SystemRepoRow, "repoId" | "cellState">>,
  activeRepoId: string | null,
): string | null {
  const attached = repos.filter((repo) => repo.cellState === "attached");
  return attached.find((repo) => repo.repoId === activeRepoId)?.repoId ?? attached[0]?.repoId ?? null;
}

/** 全局队列深度:daemon 契约未投影,由各仓队列求和派生(archive 线 service.queue.depth 的等价口径)。 */
export function totalQueueDepth(repos: ReadonlyArray<Pick<SystemRepoRow, "queueDepth">>): number | null {
  const known = repos.filter((repo) => typeof repo.queueDepth === "number");
  return known.length === 0 ? null : known.reduce((sum, repo) => sum + (repo.queueDepth ?? 0), 0);
}

function RepoRow({
  repo,
  isCurrent,
  onOpenObserve,
}: {
  readonly repo: SystemRepoRow;
  readonly isCurrent: boolean;
  readonly onOpenObserve: (repoId: string) => void;
}) {
  const label = repo.displayName?.trim() || repo.repoId,
    error = repo.lastError ?? repo.unavailableReason,
    // 只有 attached 仓有可观察的数据面;其余状态不提供死入口。
    openObserve = repo.cellState === "attached" ? onOpenObserve : undefined;
  return (
    <tr className={`border-b border-border last:border-b-0 ${isCurrent ? "bg-surface-raised/40" : ""}`}>
      <td className="max-w-[19rem] px-3 py-2 align-top">
        {/* 名称第一行,路径收进第二行弱色(标准 §2.5 v2):路径不再单占一列把其他列挤竖。 */}
        <span className="flex flex-col gap-0.5">
          <span className="font-mono ui-meta text-text">{label}</span>
          {repo.displayName ? <span className="font-mono ui-micro text-text-faint">{repo.repoId}</span> : null}
          {repo.canonicalRoot ? (
            <IdText value={repo.canonicalRoot} />
          ) : (
            <span className="font-mono ui-micro text-text-faint">{dash()}</span>
          )}
          {isCurrent ? (
            <span className="ui-micro font-medium uppercase tracking-wide text-text-muted">
              {t("views.settingsView.systemCurrentRepo")}
            </span>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <RepoModeBadge mode={repo.mode} />
      </td>
      <td className="px-3 py-2 align-top">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={repo.cellState}>
          <StatusTag tone={repoCellMeta(repo.cellState).tone} label={t(repoCellMeta(repo.cellState).labelKey)} />
          {repo.registrationState === "disabled" ? (
            <span className="font-mono ui-micro text-text-faint">({t("views.systemView.registrationDisabled")})</span>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2 text-right align-top">
        <span className="whitespace-nowrap font-mono ui-meta text-text-muted">{repo.queueDepth ?? dash()}</span>
      </td>
      <td className="px-3 py-2 align-top">
        <span className="whitespace-nowrap font-mono ui-meta text-text-muted">
          {repo.lockState === "held"
            ? t("views.systemView.lockHeld")
            : repo.lockState === "not_applicable"
              ? t("views.systemView.lockNotApplicable")
              : dash()}
        </span>
      </td>
      <td className="max-w-[16rem] px-3 py-2 align-top">
        {error ? (
          <span className="block truncate ui-meta text-status-blocked" title={error}>
            {error}
          </span>
        ) : (
          <span className="font-mono ui-micro text-text-faint">{dash()}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {openObserve ? (
          <button
            type="button"
            data-testid="system-repo-observe"
            data-repo={repo.repoId}
            title={t("views.systemView.openObserve")}
            onClick={() => openObserve(repo.repoId)}
            className={[
              "whitespace-nowrap rounded-md border border-border-strong px-2.5 py-1 ui-meta font-medium text-accent",
              "hover:bg-surface-raised",
            ].join(" ")}
          >
            {t("views.systemView.observeAction")}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

export function SystemView({
  activeRepoId,
  onOpenObserve,
  onNavigateEntity,
}: {
  readonly activeRepoId: string | null;
  /** 打开某仓的 daemon 观察详情页(事件流 + 日志流);attached 仓才有入口。 */
  readonly onOpenObserve: (repoId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const status = useSystemStatusQuery(),
    control = useDaemonControl(activeRepoId),
    receipt = control.receipt,
    [logKind, setLogKind] = useState<ObserveLogKind>("lifecycle");
  if (status.isPending) return <div className="p-6 text-text-faint">{t("views.settingsView.systemLoading")}</div>;
  if (status.isError || !status.data)
    return (
      <div className="p-6 text-status-blocked">
        {t("views.systemView.readFailed", { error: status.error instanceof Error ? status.error.message : dash() })}
      </div>
    );
  const daemon = status.data.daemon,
    attached = status.data.repos.filter((repo) => repo.cellState === "attached").length,
    unavailable = status.data.repos.filter((repo) => repo.cellState === "unavailable").length,
    queueDepth = totalQueueDepth(status.data.repos),
    logRepoId = observeRouteRepoId(status.data.repos, activeRepoId),
    // 异常仓置顶(标准 §2.5):不可用或带错误的行排在前,正常行按原顺序稳定排后。
    orderedRepos = [
      ...status.data.repos.filter((repo) => repoNeedsAttention(repo)),
      ...status.data.repos.filter((repo) => !repoNeedsAttention(repo)),
    ];
  return (
    <div className="@container flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="ui-title font-semibold">{t("shell.nav.system")}</h1>
          <span className="font-mono ui-micro text-text-faint">
            {daemon.daemonId} · pid {daemon.pid}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              disabled={!activeRepoId || control.busy}
              onClick={() => void control.request("refresh")}
              className="inline-flex items-center gap-1 rounded-xs border border-border px-2 py-1 ui-meta text-text-muted disabled:opacity-50"
            >
              <ArrowClockwise />
              {t("views.settingsView.systemRefresh")}
            </button>
          </div>
        </div>
        {receipt && (
          <div
            className={`mt-2 rounded-xs border px-2 py-1.5 font-mono ui-micro ${controlSucceeded(receipt) ? "border-status-done/30 text-status-done" : receipt.phase === "failed" ? "border-status-blocked/30 text-status-blocked" : "border-stale/30 text-stale"}`}
          >
            <span>
              {t("views.systemView.operationId")} {receipt.operationId} · {receipt.kind} · {receipt.phase}
            </span>
            {receipt.error && (
              <span>
                {" "}
                · {receipt.error.code}: {receipt.error.hint}
              </span>
            )}
          </div>
        )}
      </header>
      {/* 结论行(标准 §2.5 统计类):一句话 + 关键数字在前,字段明细与表在下。 */}
      <section
        data-testid="system-conclusion"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5"
      >
        <StatusTag tone="neutral" label={t("views.settingsView.systemRunning")} />
        <span className="ui-meta text-text">
          {t("views.systemView.conclusionRepos", {
            attached: String(attached),
            total: String(status.data.repos.length),
          })}
        </span>
        <span className="font-mono ui-meta tabular-nums text-text-muted">
          {t("views.systemView.conclusionQueue", { depth: queueDepth === null ? dash() : String(queueDepth) })}
        </span>
        <span className="font-mono ui-meta tabular-nums text-text-muted">
          {t("views.systemView.conclusionUptime", { uptime: uptime(daemon.uptimeMs) })}
        </span>
        {unavailable > 0 ? (
          <StatusTag tone="bad" label={t("views.systemView.conclusionUnavailable", { count: unavailable })} />
        ) : null}
        <span className="ml-auto font-mono ui-micro text-text-faint">{dateTime(status.data.observedAt)}</span>
      </section>
      <div data-testid="system-content" className="grid w-full gap-4 p-4 @min-[900px]:grid-cols-[16rem_minmax(0,1fr)]">
        <section className="rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="ui-body font-semibold">{t("views.settingsView.systemDaemonStatus")}</h2>
          </div>
          <dl className="mt-3 grid gap-2">
            <Field
              name={t("views.settingsView.systemVersion")}
              value={`${daemon.build.version} · ${daemon.build.commitSha?.slice(0, 10) ?? dash()}`}
              title={daemon.build.commitSha ?? undefined}
            />
            <Field
              name={t("views.settingsView.systemUptime")}
              value={uptime(daemon.uptimeMs)}
              title={`${daemon.uptimeMs} ms`}
            />
            <Field name={t("views.settingsView.systemPid")} value={String(daemon.pid)} />
            <Field name={t("views.settingsView.systemEndpoint")} value={daemon.endpoint} title={daemon.endpoint} />
            <Field name={t("views.settingsView.systemDaemonId")} value={daemon.daemonId} />
            <Field
              name={t("views.settingsView.systemUserRoot")}
              value={daemon.userRoot ?? dash()}
              title={daemon.userRoot ?? t("views.systemView.userRootNotProjected")}
            />
            <Field
              name={t("views.settingsView.systemQueueDepth")}
              value={queueDepth === null ? dash() : String(queueDepth)}
              title={t("views.systemView.queueDepthDerived")}
            />
            <Field
              name={t("views.settingsView.systemRepoSummaryLabel")}
              value={
                unavailable > 0
                  ? t("views.settingsView.systemRepoSummaryWithUnavailable", {
                      attached: String(attached),
                      total: String(status.data.repos.length),
                      count: String(unavailable),
                    })
                  : t("views.settingsView.systemRepoSummary", {
                      attached: String(attached),
                      total: String(status.data.repos.length),
                    })
              }
            />
            <Field name={t("views.systemView.started")} value={dateTime(daemon.startedAt)} />
            <Field
              name={t("views.systemView.activeControl")}
              value={
                daemon.activeControl
                  ? `${daemon.activeControl.kind} · ${daemon.activeControl.operationId} · ${daemon.activeControl.phase}`
                  : dash()
              }
            />
            <Field name={t("views.systemView.observed")} value={dateTime(status.data.observedAt)} />
          </dl>
        </section>
        <section className="rounded-lg border border-border bg-surface">
          <h2 className="border-b border-border px-3 py-2 ui-body font-semibold">
            {t("views.settingsView.systemRepos")}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border font-mono ui-meta uppercase tracking-wide text-text-faint">
                  {/* 表头与标签一律不折行(标准 §2.5 v2):列放不下时表格在容器内横向滚动,不把字挤竖。 */}
                  <th className="whitespace-nowrap px-3 py-2 font-medium">{t("views.settingsView.systemColRepo")}</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">{t("views.settingsView.systemColMode")}</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">{t("views.settingsView.systemColState")}</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">
                    {t("views.settingsView.systemColQueueDepth")}
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">{t("views.settingsView.systemColLock")}</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">
                    {t("views.settingsView.systemColLastError")}
                  </th>
                  <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    <span className="sr-only">{t("views.systemView.observeAction")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orderedRepos.map((repo) => (
                  <RepoRow
                    key={repo.repoId}
                    repo={repo}
                    isCurrent={repo.repoId === activeRepoId}
                    onOpenObserve={onOpenObserve}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {status.data.repos.some((repo) => repo.generation !== null || repo.recoveryMs !== null) && (
            <p className="border-t border-border px-3 py-1.5 font-mono ui-micro text-text-faint">
              {status.data.repos
                .filter((repo) => repo.generation !== null || repo.recoveryMs !== null)
                .map(
                  (repo) =>
                    `${repo.repoId}: ${t("views.systemView.generation")} ${repo.generation ?? dash()} · ${t("views.systemView.recovery")} ${repo.recoveryMs ?? dash()}ms`,
                )
                .join(" · ")}
            </p>
          )}
        </section>
      </div>
      <section data-testid="system-daemon-logs" className="flex h-[24rem] min-h-0 w-full shrink-0 flex-col px-4 pb-4">
        <p data-testid="system-daemon-logs-scope" className="pb-1.5 ui-micro text-text-faint">
          {t("views.systemView.logsScope", { daemonId: daemon.daemonId })}
        </p>
        {logRepoId === null ? (
          <p
            data-testid="system-daemon-logs-unavailable"
            className="rounded-sm border border-status-blocked/30 bg-status-blocked/5 px-3 py-2 ui-meta text-status-blocked"
          >
            {t("views.systemView.logsNoRoute")}
          </p>
        ) : (
          <DaemonTailPane
            key={logKind}
            repoId={logRepoId}
            kind={logKind}
            title={t("views.systemView.logsTitle")}
            kindOptions={[
              {
                value: "lifecycle",
                label: t("views.systemView.logsKindLifecycle"),
                tip: t("views.systemView.logsKindLifecycleTip"),
              },
              {
                value: "daemon-log",
                label: t("views.systemView.logsKindConn"),
                tip: t("views.systemView.logsKindConnTip"),
              },
            ]}
            onKindChange={setLogKind}
            onNavigateEntity={(ref) => onNavigateEntity(`repo/${logRepoId}/${ref}`)}
          />
        )}
      </section>
    </div>
  );
}
