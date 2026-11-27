import { useEffect, useState } from "react";
import type {
  EdgeUpgradeGuiProgress,
  EdgeUpgradeGuiReceipt,
  EdgeUpgradeGuiStatus,
} from "../../../api/edge-upgrade-contract.ts";
import type { UpdateState } from "../../../api/update-contract.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { Section } from "../../components/primitives/Section.tsx";
import { Row } from "../../components/ui/widgets";
import { guiHostBridge } from "../../gui-transport.ts";
import { t } from "../../i18n/index.tsx";

export function UpdatesSettingsPanel({ repoId }: { readonly repoId: string | null }) {
  const bridge = guiHostBridge();
  const updates = bridge?.updates;
  const edgeUpgrade = bridge?.edgeUpgrade;
  const [updateState, setUpdateState] = useState<UpdateState>({ state: "idle" });
  const [edgeStatus, setEdgeStatus] = useState<EdgeUpgradeGuiStatus | null>(null);
  const [edgeChecking, setEdgeChecking] = useState(false);
  const [edgeRunning, setEdgeRunning] = useState(false);
  const [edgeProgress, setEdgeProgress] = useState<EdgeUpgradeGuiProgress | null>(null);
  const [edgeReceipt, setEdgeReceipt] = useState<EdgeUpgradeGuiReceipt | null>(null);
  const [edgeError, setEdgeError] = useState<string | null>(null);

  useEffect(() => {
    if (!updates) return;
    void updates.status().then(setUpdateState);
    return updates.onStatus(setUpdateState);
  }, [updates]);

  useEffect(() => {
    if (!edgeUpgrade) return;
    let cancelled = false;
    setEdgeChecking(true);
    void edgeUpgrade
      .status(repoId ?? undefined)
      .then((next) => {
        if (!cancelled) {
          setEdgeStatus(next);
          setEdgeError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setEdgeError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setEdgeChecking(false);
      });
    const unsubscribe = edgeUpgrade.onProgress((progress) => {
      if (!cancelled) setEdgeProgress(progress);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [edgeUpgrade, repoId]);

  const refreshEdgeStatus = () => {
    if (!edgeUpgrade) return;
    setEdgeChecking(true);
    setEdgeError(null);
    void edgeUpgrade
      .status(repoId ?? undefined)
      .then(
        (next) => {
          setEdgeStatus(next);
        },
        (error: unknown) => {
          setEdgeError(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        setEdgeChecking(false);
      });
  };

  const executeEdgeAction = (rollback: boolean) => {
    if (!edgeUpgrade || edgeRunning) return;
    setEdgeRunning(true);
    setEdgeError(null);
    setEdgeReceipt(null);
    void edgeUpgrade
      .run({
        ...(repoId ? { repoId } : {}),
        ...(rollback ? { rollback: true } : {}),
      })
      .then((receipt) => {
        setEdgeReceipt(receipt);
        return edgeUpgrade.status(repoId ?? undefined);
      })
      .then(
        (nextStatus) => {
          setEdgeStatus(nextStatus);
        },
        (error: unknown) => {
          setEdgeError(error instanceof Error ? error.message : String(error));
        },
      )
      .finally(() => {
        setEdgeRunning(false);
      });
  };

  if (edgeStatus?.mode === "source") {
    const localShort = (edgeStatus.daemonCommit ?? edgeStatus.localCommit)?.slice(0, 12) ?? "unknown";
    const centerShort = edgeStatus.centerCommit?.slice(0, 12) ?? null;
    const statusSummary = edgeProgress
      ? `${edgeProgress.stage}: ${edgeProgress.message}`
      : edgeReceipt
        ? edgeReceipt.ok
          ? `${edgeReceipt.outcome} (${edgeReceipt.fromCommit?.slice(0, 12) ?? "?"} -> ${edgeReceipt.toCommit?.slice(0, 12) ?? "?"})`
          : `${edgeReceipt.outcome}: ${edgeReceipt.error?.hint ?? edgeReceipt.code ?? "failed"}`
        : edgeStatus.updateAvailable && centerShort
          ? `${localShort} -> ${centerShort}`
          : centerShort
            ? `${localShort} (center ${centerShort})`
            : localShort;
    return (
      <Section variant="panel" title={t("views.settingsView.sectionUpdates")}>
        <Row label={t("views.settingsView.edgeUpgradeLabel")} desc={t("views.settingsView.edgeUpgradeDescription")}>
          <div className="flex flex-wrap items-center gap-2" data-testid="edge-upgrade-controls">
            <span className="font-mono ui-meta text-text-muted" data-testid="edge-upgrade-status-text">
              {statusSummary}
            </span>
            <Button
              testId="edge-upgrade-check-btn"
              onClick={() => void refreshEdgeStatus()}
              disabled={edgeChecking || edgeRunning}
            >
              {t("views.settingsView.checkUpdates")}
            </Button>
            <Button
              variant="primary"
              testId="edge-upgrade-run-btn"
              onClick={() => void executeEdgeAction(false)}
              disabled={edgeRunning || !edgeStatus.ok}
            >
              {edgeRunning ? t("views.settingsView.edgeUpgrading") : t("views.settingsView.edgeUpgradeAction")}
            </Button>
            {edgeStatus.canRollback ? (
              <Button
                testId="edge-upgrade-rollback-btn"
                onClick={() => void executeEdgeAction(true)}
                disabled={edgeRunning}
              >
                {t("views.settingsView.edgeRollbackAction")}
              </Button>
            ) : null}
            {edgeReceipt?.guiRestartRequired ? (
              <Button variant="primary" testId="edge-upgrade-relaunch-btn" onClick={() => void edgeUpgrade?.relaunch()}>
                {t("views.settingsView.edgeRestartGuiAction")}
              </Button>
            ) : null}
          </div>
        </Row>
        {edgeError ? (
          <p className="px-3 pb-2 ui-meta text-status-blocked" data-testid="edge-upgrade-error">
            {edgeError}
          </p>
        ) : edgeStatus.reason ? (
          <p className="px-3 pb-2 ui-meta text-text-muted" data-testid="edge-upgrade-reason">
            {edgeStatus.reason}
          </p>
        ) : null}
      </Section>
    );
  }

  return (
    <Section variant="panel" title={t("views.settingsView.sectionUpdates")}>
      <Row label={t("views.settingsView.updateStatusLabel")} desc={t("views.settingsView.updateStatusDescription")}>
        <div className="flex items-center gap-2" data-testid="packaged-update-controls">
          <span className="ui-meta text-text-muted">
            {updateState.state === "available" || updateState.state === "downloaded"
              ? updateState.version
              : updateState.state}
          </span>
          <Button onClick={() => void updates?.check()} disabled={!updates || updateState.state === "checking"}>
            {t("views.settingsView.checkUpdates")}
          </Button>
          {updateState.state === "downloaded" ? (
            <Button variant="primary" onClick={() => void updates?.install()}>
              {t("views.settingsView.installUpdate")}
            </Button>
          ) : null}
        </div>
      </Row>
    </Section>
  );
}
