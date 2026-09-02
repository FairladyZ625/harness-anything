import { useState } from "react";
import { ArrowsLeftRight, Trash } from "@phosphor-icons/react";
import type { AdminConnectionRow } from "../../../api/connection-admin-contract.ts";
import type { SystemRepoRow } from "../../api-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { t } from "../../i18n/index.tsx";
import { useRepoAdminMutations } from "../../connection-data.ts";
import { BTN, Row, Section, Segmented, Toggle } from "../../components/ui/widgets.tsx";
import { RepoModeBadge, repoModeLabel } from "../../components/RepoModeBadge.tsx";
import { centerConnectionAvailable, isRemoteProxy } from "./connectionTree.ts";

/**
 * 仓库节点详情面(设计稿 §3.2 的行/仓动作):displayName 编辑、启用停用、
 * 设为当前、移除、模式切换。模式规则:
 *   - workspace-backed(local/remote-center/remote-edge)↔ remote-edge 需中心连接;
 *   - remote-proxy 仓不可切 local(本机无 root),面板以固定提示取代切换器
 *     (「要本地开发请 SSH 到服务器或注册本机仓」),点击动作也被同一提示拒绝。
 */
export function RepoDetailPanel({
  repo,
  isCurrent,
  connections,
  onOpenProject,
}: {
  readonly repo: SystemRepoRow;
  readonly isCurrent: boolean;
  readonly connections: readonly AdminConnectionRow[];
  readonly onOpenProject: (repoId: string) => void;
}) {
  const repoMutations = useRepoAdminMutations();
  const [displayName, setDisplayName] = useState(repo.displayName),
    [feedback, setFeedback] = useState<string | null>(null);
  const proxy = isRemoteProxy(repo),
    hasCenter = centerConnectionAvailable(connections),
    enabled = repo.registrationState === "enabled",
    endpoint = connections.find((connection) => connection.id === repo.connectionId)?.endpoint;

  const withFeedback = async (action: () => Promise<unknown>) => {
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      consumeKnownError(error);
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const switchMode = (mode: "local" | "remote-edge") => {
    if (proxy) {
      setFeedback(t("views.repositories.proxyToLocalHint"));
      return;
    }
    if (mode === "remote-edge" && !hasCenter) {
      setFeedback(t("views.repositories.centerRequiredHint"));
      return;
    }
    void withFeedback(() => repoMutations.update.mutateAsync({ repoId: repo.repoId, mode }));
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title={t("views.repositories.repoTitle")}
        action={
          <span className="inline-flex items-center gap-1.5">
            <RepoModeBadge mode={repo.mode} />
            {isCurrent ? (
              <span className="font-mono ui-micro text-accent">{t("views.repositories.currentMark")}</span>
            ) : null}
          </span>
        }
      >
        <Row
          label={t("views.repositories.repoIdLabel")}
          desc={repo.canonicalRoot ?? t("views.repositories.noLocalRoot")}
        >
          <span className="font-mono ui-meta text-text-muted">{repo.repoId}</span>
        </Row>
        {endpoint ? (
          <Row label={t("views.repositories.endpointLabel")}>
            <span className="max-w-full break-all font-mono ui-micro text-text-muted">{endpoint}</span>
          </Row>
        ) : null}
        <Row label={t("views.repositories.displayNameLabel")}>
          <input
            data-testid="repo-display-name"
            aria-label={t("views.repositories.displayNameLabel")}
            className="w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <button
            data-testid="repo-save-display-name"
            className={BTN}
            disabled={
              repoMutations.update.isPending || displayName.trim().length === 0 || displayName === repo.displayName
            }
            onClick={() =>
              void withFeedback(() =>
                repoMutations.update.mutateAsync({ repoId: repo.repoId, displayName: displayName.trim() }),
              )
            }
          >
            {t("views.repositories.saveAction")}
          </button>
        </Row>
        <Row label={t("views.repositories.repoStateLabel")} desc={t("views.repositories.repoStateHint")}>
          <Toggle
            checked={enabled}
            disabled={repoMutations.update.isPending}
            onChange={(state) =>
              void withFeedback(() =>
                repoMutations.update.mutateAsync({ repoId: repo.repoId, state: state ? "enabled" : "disabled" }),
              )
            }
          />
        </Row>
        <Row
          label={t("views.repositories.modeLabelTitle")}
          desc={
            proxy
              ? t("views.repositories.proxyToLocalHint")
              : hasCenter
                ? undefined
                : t("views.repositories.centerRequiredHint")
          }
        >
          {proxy ? (
            <span className="inline-flex items-center gap-1.5 ui-meta text-text-faint">
              <ArrowsLeftRight className="size-3.5" />
              {t("views.repositories.modeSwitchUnavailable")}
            </span>
          ) : (
            <Segmented
              value={repo.mode === "remote-edge" ? "remote-edge" : "local"}
              disabled={!hasCenter || repoMutations.update.isPending}
              options={[
                { key: "local", label: repoModeLabel("local") },
                { key: "remote-edge", label: repoModeLabel("remote-edge") },
              ]}
              onChange={(key) => switchMode(key)}
            />
          )}
        </Row>
        <Row
          label={t("views.repositories.setCurrent")}
          desc={enabled ? undefined : t("views.repositories.setCurrentDisabledHint")}
        >
          <button
            data-testid="repo-set-current"
            className={BTN}
            disabled={!enabled || isCurrent}
            onClick={() => onOpenProject(repo.repoId)}
          >
            {t("views.repositories.setCurrentAction")}
          </button>
        </Row>
        <Row label={t("views.repositories.removeRepoLabel")} desc={t("views.repositories.removeRepoHint")}>
          <button
            data-testid="repo-remove"
            className={BTN}
            disabled={repoMutations.unregister.isPending}
            onClick={() => void withFeedback(() => repoMutations.unregister.mutateAsync(repo.repoId))}
          >
            <Trash className="mr-1 inline size-3" weight="bold" />
            {t("views.repositories.removeRepoAction")}
          </button>
        </Row>
        {feedback ? (
          <p data-testid="repo-feedback" className="px-3 py-2 ui-meta text-status-blocked">
            {feedback}
          </p>
        ) : null}
      </Section>
    </div>
  );
}
