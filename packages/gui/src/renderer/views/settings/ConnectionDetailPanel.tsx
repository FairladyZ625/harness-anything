import { useState } from "react";
import { ArrowsClockwise, CheckSquare, Trash, Square } from "@phosphor-icons/react";
import type { AdminConnectionRow, ConnectionProbeSuccess } from "../../../api/connection-admin-contract.ts";
import type { SystemRepoRow } from "../../api-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { t } from "../../i18n/index.tsx";
import { useConnectionMutations, useRepoAdminMutations } from "../../connection-data.ts";
import { BTN, Row, Section, Toggle } from "../../components/ui/widgets.tsx";

/**
 * 远端端点连接的详情面(设计稿 §3.2「远端端点连接」列):
 * 添加(名字 + endpoint → 立即 probe,显示远端 daemon 版本与仓库列表)、
 * 编辑(displayName / endpoint / 启用停用)、移除(下有启用仓库时先提示移仓库)、
 * 从 probe 结果勾选仓库注册为 remote-proxy。
 * 所有动作经 daemon.connection.* / daemon.repo.* admin RPC;GUI 不拨端点。
 */

const INPUT_CLASS = [
  "w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1",
  "font-mono ui-meta text-text",
].join(" ");

export function ConnectionDetailPanel({
  mode,
  connection,
  repos,
  allRepoIds,
  onDone,
}: {
  readonly mode: "add" | "edit";
  readonly connection: AdminConnectionRow | null;
  readonly repos: readonly SystemRepoRow[];
  readonly allRepoIds: readonly string[];
  readonly onDone: () => void;
}) {
  const connectionMutations = useConnectionMutations(),
    repoMutations = useRepoAdminMutations();
  const [displayName, setDisplayName] = useState(connection?.displayName ?? ""),
    [endpoint, setEndpoint] = useState(connection?.endpoint ?? ""),
    [probe, setProbe] = useState<ConnectionProbeSuccess | null>(null),
    [checked, setChecked] = useState<ReadonlySet<string>>(new Set()),
    [feedback, setFeedback] = useState<string | null>(null),
    // 添加流程里连接先落 registry、再从 probe 结果勾选注册;这里记住回执里的连接 id。
    [addedConnectionId, setAddedConnectionId] = useState<string | null>(null);
  const activeConnectionId = mode === "edit" ? (connection?.id ?? null) : addedConnectionId;
  const busy = connectionMutations.register.isPending || connectionMutations.update.isPending;

  const submitConnection = async () => {
    setFeedback(null);
    if (endpoint.trim().length === 0) {
      setFeedback(t("views.repositories.endpointRequired"));
      return;
    }
    try {
      if (mode === "add") {
        const receipt = await connectionMutations.register.mutateAsync({
          displayName: displayName.trim().length > 0 ? displayName.trim() : undefined,
          endpoint: endpoint.trim(),
        });
        if (receipt.connection) setAddedConnectionId(receipt.connection.id);
      } else if (connection) {
        await connectionMutations.update.mutateAsync({
          connectionId: connection.id,
          displayName: displayName.trim().length > 0 ? displayName.trim() : undefined,
          endpoint: endpoint.trim(),
        });
      }
      await runProbe(endpoint.trim());
      if (mode === "add") setFeedback(t("views.repositories.connectionAdded"));
    } catch (error) {
      consumeKnownError(error);
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const runProbe = async (target: string) => {
    try {
      const result = await connectionMutations.probe.mutateAsync(target);
      setProbe(result);
      setChecked(new Set());
    } catch (error) {
      consumeKnownError(error);
      setProbe(null);
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleRepo = (repoId: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });

  const registerChecked = async () => {
    if (activeConnectionId === null || checked.size === 0) return;
    setFeedback(null);
    const failures: string[] = [];
    for (const repoId of checked) {
      try {
        await repoMutations.register.mutateAsync({
          repoId,
          mode: "remote-proxy",
          connectionId: activeConnectionId,
        });
      } catch (error) {
        consumeKnownError(error);
        failures.push(`${repoId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setChecked(new Set());
    setFeedback(failures.length === 0 ? t("views.repositories.reposRegistered") : failures.join("; "));
  };

  const removeConnection = async () => {
    if (!connection) return;
    setFeedback(null);
    try {
      await connectionMutations.unregister.mutateAsync(connection.id);
      onDone();
    } catch (error) {
      consumeKnownError(error);
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const hasEnabledRepos = repos.some((repo) => repo.registrationState === "enabled");

  return (
    <div className="flex flex-col gap-3">
      <Section
        title={
          mode === "add" ? t("views.repositories.addConnectionTitle") : t("views.repositories.editConnectionTitle")
        }
        action={
          <button
            data-testid="connection-submit"
            className={BTN}
            disabled={busy || connectionMutations.probe.isPending}
            onClick={() => void submitConnection()}
          >
            {mode === "add"
              ? t("views.repositories.addConnectionAction")
              : t("views.repositories.saveConnectionAction")}
          </button>
        }
      >
        <Row label={t("views.repositories.displayNameLabel")}>
          <input
            data-testid="connection-display-name"
            aria-label={t("views.repositories.displayNameLabel")}
            className={INPUT_CLASS}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Row>
        <Row
          label={t("views.repositories.endpointLabel")}
          desc={mode === "add" ? t("views.repositories.endpointAddHint") : undefined}
        >
          <input
            data-testid="connection-endpoint"
            aria-label={t("views.repositories.endpointLabel")}
            className={INPUT_CLASS}
            placeholder="tcp://127.0.0.1:9911"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </Row>
        {mode === "edit" && connection ? (
          <>
            <Row
              label={t("views.repositories.connectionStateLabel")}
              desc={t("views.repositories.connectionStateHint")}
            >
              <Toggle
                checked={connection.state === "enabled"}
                disabled={connectionMutations.update.isPending}
                onChange={(state) => {
                  setFeedback(null);
                  connectionMutations.update.mutate(
                    { connectionId: connection.id, state: state ? "enabled" : "disabled" },
                    {
                      onError: (error) => setFeedback(error instanceof Error ? error.message : String(error)),
                    },
                  );
                }}
              />
            </Row>
            <Row
              label={t("views.repositories.removeConnectionLabel")}
              desc={
                hasEnabledRepos
                  ? t("views.repositories.removeConnectionBlocked")
                  : t("views.repositories.removeConnectionHint")
              }
            >
              <button
                data-testid="connection-remove"
                className={BTN}
                disabled={hasEnabledRepos || connectionMutations.unregister.isPending}
                title={hasEnabledRepos ? t("views.repositories.removeConnectionBlocked") : undefined}
                onClick={() => void removeConnection()}
              >
                <Trash className="mr-1 inline size-3" weight="bold" />
                {t("views.repositories.removeConnectionAction")}
              </button>
            </Row>
          </>
        ) : null}
        {feedback ? (
          <p data-testid="connection-feedback" className="px-3 py-2 ui-meta text-status-blocked">
            {feedback}
          </p>
        ) : null}
      </Section>

      <Section
        title={t("views.repositories.probeTitle")}
        action={
          <button
            data-testid="connection-probe"
            className={BTN}
            disabled={endpoint.trim().length === 0 || connectionMutations.probe.isPending}
            onClick={() => void runProbe(endpoint.trim())}
          >
            <ArrowsClockwise className="mr-1 inline size-3" />
            {connectionMutations.probe.isPending
              ? t("views.repositories.probePending")
              : t("views.repositories.probeAction")}
          </button>
        }
      >
        {probe ? (
          <>
            <Row label={t("views.repositories.probeVersion")}>
              <span className="font-mono ui-meta text-text-muted">
                v{probe.protocolVersion.major}.{probe.protocolVersion.minor} ·{" "}
                {probe.build.commit?.slice(0, 10) ?? t("views.repositories.probeCommitUnknown")}
              </span>
            </Row>
            <div className="border-b border-border px-3 py-2">
              <p className="ui-meta text-text-faint">{t("views.repositories.probeRepos")}</p>
              <ul data-testid="probe-repo-list" className="mt-1 flex flex-col gap-1">
                {probe.repos.map((repo) => {
                  const registered = allRepoIds.includes(repo.repoId);
                  return (
                    <li key={repo.repoId} className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`probe-repo-check-${repo.repoId}`}
                        disabled={registered || repo.mode === null}
                        onClick={() => toggleRepo(repo.repoId)}
                        className={
                          "inline-flex items-center gap-1.5 rounded px-1 " +
                          "py-0.5 ui-meta text-text disabled:cursor-not-allowed disabled:opacity-50"
                        }
                        title={registered ? t("views.repositories.probeRepoRegistered") : repo.repoId}
                      >
                        {checked.has(repo.repoId) ? (
                          <CheckSquare weight="fill" className="size-3.5 text-accent" />
                        ) : (
                          <Square className="size-3.5" />
                        )}
                        <span className="font-mono">{repo.repoId}</span>
                        <span className="font-mono ui-micro text-text-faint">{repo.mode ?? "—"}</span>
                      </button>
                      {registered ? (
                        <span className="font-mono ui-micro text-text-faint">
                          {t("views.repositories.probeRepoRegistered")}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <button
                data-testid="probe-register-selected"
                className={`${BTN} mt-2`}
                disabled={activeConnectionId === null || checked.size === 0 || repoMutations.register.isPending}
                onClick={() => void registerChecked()}
              >
                {t("views.repositories.registerSelectedAction")}
              </button>
            </div>
          </>
        ) : (
          <p className="px-3 py-2 ui-meta text-text-faint">{t("views.repositories.probeIdle")}</p>
        )}
      </Section>

      {mode === "edit" ? (
        <Section title={t("views.repositories.connectionReposTitle")}>
          {repos.length === 0 ? (
            <p className="px-3 py-2 ui-meta text-text-faint">{t("views.repositories.connectionReposEmpty")}</p>
          ) : (
            repos.map((repo) => (
              <Row key={repo.repoId} label={repo.displayName || repo.repoId} desc={repo.repoId}>
                <span className="font-mono ui-micro text-text-faint">
                  {t(`views.repositories.modeLabel.${repo.mode}`)}
                </span>
              </Row>
            ))
          )}
        </Section>
      ) : null}
    </div>
  );
}
