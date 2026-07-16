import type { DaemonRepoStatus, DaemonStatusModel } from "../../model/daemon-status.ts";
import { daemonRepoRows } from "../../model/daemon-status.ts";
import { t } from "../../i18n/index.tsx";

/** Map daemon repo state → badge tone colors (v2 4-state enum). */
function stateTone(state: string): { color: string; bg: string } {
  const normalized = state.toLowerCase();
  if (normalized === "attached") {
    return {
      color: "var(--color-success)",
      bg: "color-mix(in oklch, var(--color-success) 12%, transparent)",
    };
  }
  if (normalized === "unavailable") {
    return {
      color: "var(--color-danger)",
      bg: "color-mix(in oklch, var(--color-danger) 12%, transparent)",
    };
  }
  // detaching / detached (and any unknown) → muted
  return {
    color: "var(--color-text-muted)",
    bg: "color-mix(in oklch, var(--color-text-muted) 10%, transparent)",
  };
}

function StatePill({ state }: { state: string }) {
  const tone = stateTone(state);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[12px] font-medium"
      style={{ color: tone.color, background: tone.bg }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: tone.color }}
        aria-hidden
      />
      {state}
    </span>
  );
}

function RepoRow({
  repo,
  isCurrent,
}: {
  repo: DaemonRepoStatus;
  isCurrent: boolean;
}) {
  const lockLabel = repo.lock.path ?? t("views.settingsView.systemUnlockedDash");
  const errorText =
    repo.lastError ??
    repo.lastMaterializerError ??
    repo.lastReconcileError?.message ??
    null;
  const label = repo.displayName?.trim() || repo.repoId;

  return (
    <tr
      className={`border-b border-border last:border-b-0 ${
        isCurrent ? "bg-surface-raised/40" : ""
      }`}
    >
      <td className="px-3 py-2 align-top">
        <span className="inline-flex flex-col gap-0.5">
          <span className="font-mono text-[12px] text-text">{label}</span>
          {repo.displayName ? (
            <span className="font-mono text-[10px] text-text-faint">{repo.repoId}</span>
          ) : null}
          {isCurrent ? (
            <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
              {t("views.settingsView.systemCurrentRepo")}
            </span>
          ) : null}
        </span>
      </td>
      <td className="max-w-[16rem] px-3 py-2 align-top">
        <span
          className="block truncate font-mono text-[11px] text-text-muted"
          title={repo.canonicalRoot}
        >
          {repo.canonicalRoot || "—"}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <StatePill state={repo.state} />
      </td>
      <td className="px-3 py-2 align-top">
        <span className="font-mono text-[12px] text-text-muted">{repo.queue.depth}</span>
      </td>
      <td className="max-w-[14rem] px-3 py-2 align-top">
        <span
          className="block truncate font-mono text-[11px] text-text-muted"
          title={repo.lock.path ?? undefined}
        >
          {lockLabel}
        </span>
      </td>
      <td className="max-w-[16rem] px-3 py-2 align-top">
        {errorText ? (
          <span className="block truncate text-[12px] text-danger" title={errorText}>
            {errorText}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-text-faint">—</span>
        )}
      </td>
    </tr>
  );
}

export function DaemonRepoTable({ status }: { status: DaemonStatusModel }) {
  const rows = daemonRepoRows(status);
  const currentRepoId = status.requestedRepo.repoId;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border font-mono text-[12px] uppercase tracking-wide text-text-faint">
            <th className="px-3 py-2 font-medium">
              {t("views.settingsView.systemColRepo")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("views.settingsView.systemColRoot")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("views.settingsView.systemColState")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("views.settingsView.systemColQueueDepth")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("views.settingsView.systemColLock")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("views.settingsView.systemColLastError")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((repo) => (
            <RepoRow
              key={repo.repoId}
              repo={repo}
              isCurrent={repo.repoId === currentRepoId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
