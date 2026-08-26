import { ArrowClockwise, Power } from "@phosphor-icons/react";
import { controlSucceeded, useDaemonControl, useSystemStatusQuery } from "../system-data.ts";
import type { SystemRepoRow } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";

/**
 * System 面板:面向使用者的守护进程状态 + 本地仓库表。
 *
 * 字段口径与 archive 线 SystemStatusPanel 对齐(版本/运行时长/PID/端点/守护进程 ID/
 * 用户根目录/队列深度/仓库数 + 仓库表)。连接数(活跃/总计)与全局队列深度在
 * gui-system-status/v1 契约里没有投影,呈现为「—」并在 title 说明,不伪造。
 * 机器值(generation 序号、recovery 毫秒)保留为次级行,不再作为唯一呈现。
 */
const dash = () => t("views.settingsView.systemUnknownDash");
const dateTime = (iso: string) => formatTime(iso, { style: "date-time-seconds" }) ?? dash();

export function formatUptimeMs(uptimeMs: number | undefined): string {
  if (typeof uptimeMs !== "number" || !Number.isFinite(uptimeMs) || uptimeMs < 0) return dash();
  const totalSec = Math.floor(uptimeMs / 1000),
    days = Math.floor(totalSec / 86_400),
    hours = Math.floor((totalSec % 86_400) / 3_600),
    minutes = Math.floor((totalSec % 3_600) / 60),
    seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function Field({ name, value, title }: { readonly name: string; readonly value: string; readonly title?: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase text-text-faint">{name}</dt>
      <dd className="break-all font-mono text-[12px] text-text-muted" title={title}>
        {value}
      </dd>
    </div>
  );
}

function ReachabilityBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-status-done/15 px-2.5 py-1 text-[12px] font-semibold text-status-done">
      <span className="size-2 rounded-full bg-status-done" aria-hidden />
      {t("views.settingsView.systemRunning")}
    </span>
  );
}

/** RepoCell 状态的呈现口径:状态词走 i18n(不把 attached/not_loaded 这类机器枚举直接摊给使用者),颜色与之同源。 */
const REPO_STATE = {
  warming: ["text-stale", "stateWarming"],
  attached: ["text-status-done", "stateAttached"],
  unavailable: ["text-status-blocked", "stateUnavailable"],
  not_loaded: ["text-text-muted", "stateNotLoaded"],
} as const;

/** 全局队列深度:daemon 契约未投影,由各仓队列求和派生(archive 线 service.queue.depth 的等价口径)。 */
export function totalQueueDepth(repos: ReadonlyArray<Pick<SystemRepoRow, "queueDepth">>): number | null {
  const known = repos.filter((repo) => typeof repo.queueDepth === "number");
  return known.length === 0 ? null : known.reduce((sum, repo) => sum + (repo.queueDepth ?? 0), 0);
}

function RepoRow({ repo, isCurrent }: { readonly repo: SystemRepoRow; readonly isCurrent: boolean }) {
  const label = repo.displayName?.trim() || repo.repoId,
    error = repo.lastError ?? repo.unavailableReason;
  return (
    <tr className={`border-b border-border last:border-b-0 ${isCurrent ? "bg-surface-raised/40" : ""}`}>
      <td className="px-3 py-2 align-top">
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-[12px] text-text">{label}</span>
          {repo.displayName ? <span className="font-mono text-[10px] text-text-faint">{repo.repoId}</span> : null}
          {isCurrent ? (
            <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
              {t("views.settingsView.systemCurrentRepo")}
            </span>
          ) : null}
        </span>
      </td>
      <td className="max-w-[16rem] px-3 py-2 align-top">
        <span className="block truncate font-mono text-[11px] text-text-muted" title={repo.canonicalRoot}>
          {repo.canonicalRoot || dash()}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className={`inline-flex items-center gap-1 font-mono text-[12px] ${REPO_STATE[repo.cellState][0]}`}
          title={repo.cellState}
        >
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {t(`views.systemView.${REPO_STATE[repo.cellState][1]}`)}
        </span>
        {repo.registrationState === "disabled" ? (
          <span className="ml-1 font-mono text-[10px] text-text-faint">
            ({t("views.systemView.registrationDisabled")})
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top">
        <span className="font-mono text-[12px] text-text-muted">{repo.queueDepth ?? dash()}</span>
      </td>
      <td className="px-3 py-2 align-top">
        <span className="font-mono text-[12px] text-text-muted">
          {repo.lockState === "held"
            ? t("views.systemView.lockHeld")
            : repo.lockState === "not_applicable"
              ? t("views.systemView.lockNotApplicable")
              : dash()}
        </span>
      </td>
      <td className="max-w-[16rem] px-3 py-2 align-top">
        {error ? (
          <span className="block truncate text-[12px] text-status-blocked" title={error}>
            {error}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-text-faint">{dash()}</span>
        )}
      </td>
    </tr>
  );
}

export function SystemView({ activeRepoId }: { readonly activeRepoId: string | null }) {
  const status = useSystemStatusQuery(),
    control = useDaemonControl(activeRepoId),
    receipt = control.receipt;
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
    queueDepth = totalQueueDepth(status.data.repos);
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="ui-title font-semibold">{t("shell.nav.system")}</h1>
          <span className="font-mono text-[11px] text-text-faint">
            {daemon.daemonId} · pid {daemon.pid}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              disabled={!activeRepoId || control.busy}
              onClick={() => void control.request("refresh")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-text-muted disabled:opacity-50"
            >
              <ArrowClockwise />
              {t("views.settingsView.systemRefresh")}
            </button>
            <button
              disabled={!activeRepoId || control.busy}
              onClick={() => void control.request("restart")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-text-muted disabled:opacity-50"
            >
              <Power />
              {t("views.settingsView.systemRestart")}
            </button>
          </div>
        </div>
        {receipt && (
          <div
            className={`mt-2 rounded border px-2 py-1.5 font-mono text-[11px] ${controlSucceeded(receipt) ? "border-status-done/30 text-status-done" : receipt.phase === "failed" ? "border-status-blocked/30 text-status-blocked" : "border-stale/30 text-stale"}`}
          >
            <span>
              {t("views.systemView.operationId")} {receipt.operationId} · {receipt.kind} · {receipt.phase}
            </span>
            {receipt.kind === "restart" && receipt.phase === "settled" && (
              <span>
                {" "}
                · pid {receipt.before?.pid ?? dash()} → {receipt.after?.pid ?? dash()}
              </span>
            )}
            {receipt.error && (
              <span>
                {" "}
                · {receipt.error.code}: {receipt.error.hint}
              </span>
            )}
          </div>
        )}
      </header>
      <div data-testid="system-content" className="grid w-full gap-4 p-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold">{t("views.settingsView.systemDaemonStatus")}</h2>
            <ReachabilityBadge />
          </div>
          {daemon.buildStale ? (
            <p
              className="mt-2 rounded border border-status-blocked/30 bg-status-blocked/5 px-2 py-1.5 text-[12px] text-status-blocked"
              title={`${daemon.buildStale.daemonCommit} → ${daemon.buildStale.clientCommit}`}
            >
              {t("views.systemView.buildStale", {
                daemon: daemon.buildStale.daemonCommit.slice(0, 12),
                client: daemon.buildStale.clientCommit.slice(0, 12),
              })}
            </p>
          ) : null}
          <dl className="mt-3 grid gap-2">
            <Field
              name={t("views.settingsView.systemVersion")}
              value={`${daemon.build.version} · ${daemon.build.commitSha?.slice(0, 10) ?? dash()}`}
              title={daemon.build.commitSha ?? undefined}
            />
            <Field
              name={t("views.settingsView.systemUptime")}
              value={formatUptimeMs(daemon.uptimeMs)}
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
          <h2 className="border-b border-border px-3 py-2 text-[13px] font-semibold">
            {t("views.settingsView.systemRepos")}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border font-mono text-[12px] uppercase tracking-wide text-text-faint">
                  <th className="px-3 py-2 font-medium">{t("views.settingsView.systemColRepo")}</th>
                  <th className="px-3 py-2 font-medium">{t("views.settingsView.systemColRoot")}</th>
                  <th className="px-3 py-2 font-medium">{t("views.settingsView.systemColState")}</th>
                  <th className="px-3 py-2 font-medium">{t("views.settingsView.systemColQueueDepth")}</th>
                  <th className="px-3 py-2 font-medium">{t("views.settingsView.systemColLock")}</th>
                  <th className="px-3 py-2 font-medium">{t("views.settingsView.systemColLastError")}</th>
                </tr>
              </thead>
              <tbody>
                {status.data.repos.map((repo) => (
                  <RepoRow key={repo.repoId} repo={repo} isCurrent={repo.repoId === activeRepoId} />
                ))}
              </tbody>
            </table>
          </div>
          {status.data.repos.some((repo) => repo.generation !== null || repo.recoveryMs !== null) && (
            <p className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-text-faint">
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
    </div>
  );
}
