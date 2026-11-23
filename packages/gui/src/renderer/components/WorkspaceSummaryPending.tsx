import { t, type MessageKey } from "../i18n/index.tsx";
import { extractReplicaSyncProgress, formatSyncBytes, replicaSyncPercent } from "../repository-read-frame.ts";

export function WorkspaceSummaryPending({ error }: { error: unknown }) {
  const authenticationRequired = error instanceof Error && "code" in error && error.code === "authentication_required";
  const replicaSyncing = error instanceof Error && "code" in error && error.code === "replica_syncing";
  if (replicaSyncing) {
    const progress = extractReplicaSyncProgress(error);
    const percent = replicaSyncPercent(progress);
    const detailLine = progress
      ? [
          t(`components.workspaceSummary.syncStep.${progress.step}` as MessageKey),
          typeof progress.receivedObjects === "number" && typeof progress.totalObjects === "number"
            ? `${progress.receivedObjects} / ${progress.totalObjects}`
            : null,
          progress.totalBytes !== null && progress.totalBytes > 0
            ? `${formatSyncBytes(progress.receivedBytes)} / ${formatSyncBytes(progress.totalBytes)}`
            : progress.receivedBytes > 0
              ? formatSyncBytes(progress.receivedBytes)
              : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : error.message;
    return (
      <div
        data-testid="workspace-replica-syncing"
        className="m-5 max-w-xl rounded-lg border border-stale/40 bg-stale/5 p-4 text-text"
      >
        <div className="flex items-center justify-between gap-3 ui-body font-medium">
          <span className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-stale animate-pulse" />
            <span>{t("components.workspaceSummary.replicaSyncingTitle")}</span>
          </span>
          {percent !== null && <span className="font-mono tabular-nums text-stale">{percent}%</span>}
        </div>
        <div
          role="progressbar"
          data-testid="workspace-replica-sync-progress"
          aria-label={t("components.workspaceSummary.replicaSyncingTitle")}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent !== null ? { "aria-valuenow": percent } : {})}
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
        >
          <div
            className={`h-full rounded-full bg-stale transition-all ${percent === null ? "animate-pulse" : ""}`}
            style={{ width: `${percent ?? 25}%` }}
          />
        </div>
        <div
          data-testid="workspace-replica-sync-detail"
          className="mt-2 font-mono ui-micro tabular-nums text-text-faint"
        >
          {detailLine}
        </div>
      </div>
    );
  }
  return (
    <div className="m-5 rounded-lg border border-border p-4 ui-body text-text-faint">
      {authenticationRequired
        ? t("components.workspaceSummary.authenticationRequired")
        : error instanceof Error
          ? error.message
          : t("components.appSidebar.readLocalLedger")}
    </div>
  );
}
