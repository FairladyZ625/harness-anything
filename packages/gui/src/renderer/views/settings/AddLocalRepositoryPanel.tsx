import { useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import type { FirstRunApi, FirstRunBootstrapInput } from "../../../api/first-run-contract.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { t } from "../../i18n/index.tsx";
import { inspectWorkspace } from "../../connection-admin-client.ts";
import { useRepoAdminMutations } from "../../connection-data.ts";
import { BTN, Row, Section } from "../../components/ui/widgets.tsx";
import { RepoModeBadge } from "../../components/RepoModeBadge.tsx";

/**
 * 本机连接详情面(设计稿 §3.2「本机连接」列):其下仓库列表 + 「添加本机仓库」。
 * 添加流程 = 首次运行流程并入本页后的唯一形态:选文件夹 → 已有台账则注册
 * (daemon.repo.register),无台账则 bootstrap(daemon.repo.bootstrap,沿用
 * registerFirstRunIpcHandlers 的两个 IPC)。纯展示(remote-proxy)连接不提供本面。
 */
export function AddLocalRepositoryPanel({
  repos,
  activeRepoId,
  onOpenProject,
}: {
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly onOpenProject: (repoId: string) => void;
}) {
  const repoMutations = useRepoAdminMutations();
  const [rootDir, setRootDir] = useState(""),
    [repoId, setRepoId] = useState(""),
    [mode, setMode] = useState<"idle" | "register" | "bootstrap">("idle"),
    [personId, setPersonId] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [name, setName] = useState(""),
    [addNpmScripts, setAddNpmScripts] = useState(false),
    [feedback, setFeedback] = useState<string | null>(null),
    [busy, setBusy] = useState(false);

  const firstRun = firstRunApi();

  const chooseFolder = async () => {
    setFeedback(null);
    try {
      const selected = await firstRun.chooseRepository();
      if (selected === null) return;
      setRootDir(selected);
      const inspected = await inspectWorkspace(selected);
      setRepoId(inspected.suggestedRepoId);
      if (!name) setName(selected.split(/[\\/]/u).filter(Boolean).at(-1) ?? "");
      setMode(inspected.hasWorkspace ? "register" : "bootstrap");
    } catch (error) {
      consumeKnownError(error);
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const submitRegister = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await repoMutations.register.mutateAsync({ rootDir, repoId: repoId.trim(), mode: "local" });
      onOpenProject(repoId.trim());
      setMode("idle");
      setRootDir("");
      setRepoId("");
    } catch (error) {
      consumeKnownError(error);
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const submitBootstrap = async () => {
    setBusy(true);
    setFeedback(null);
    const input: FirstRunBootstrapInput = {
      rootDir,
      repoId: repoId.trim(),
      personId: personId.trim(),
      displayName: displayName.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(addNpmScripts ? { addNpmScripts: true } : {}),
    };
    try {
      const receipt = await firstRun.bootstrap(input);
      if (!successfulBootstrap(receipt)) throw new Error(receiptHint(receipt));
      onOpenProject(input.repoId);
      setMode("idle");
      setRootDir("");
      setRepoId("");
      setPersonId("");
      setDisplayName("");
    } catch (error) {
      consumeKnownError(error);
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {repos.length === 0 ? (
        <div data-testid="local-empty-state" className="rounded-lg border border-dashed border-border bg-surface p-4">
          <p className="ui-body font-medium">{t("views.repositories.emptyTitle")}</p>
          <p className="mt-1 ui-meta text-text-muted">{t("views.repositories.emptyHint")}</p>
        </div>
      ) : null}

      <Section title={t("views.repositories.localReposTitle")}>
        {repos.length === 0 ? (
          <p className="px-3 py-2 ui-meta text-text-faint">{t("views.repositories.localReposEmpty")}</p>
        ) : (
          repos.map((repo) => (
            <Row key={repo.repoId} label={repo.displayName || repo.repoId} desc={repo.canonicalRoot ?? repo.repoId}>
              <RepoModeBadge mode={repo.mode} />
              {repo.repoId === activeRepoId ? (
                <span className="font-mono ui-micro text-accent">{t("views.repositories.currentMark")}</span>
              ) : null}
            </Row>
          ))
        )}
      </Section>

      <Section
        title={t("views.repositories.addLocalTitle")}
        action={
          <button data-testid="add-local-choose" className={BTN} onClick={() => void chooseFolder()}>
            <FolderOpen className="mr-1 inline size-3" />
            {t("views.repositories.chooseFolder")}
          </button>
        }
      >
        {mode === "idle" ? (
          <p className="px-3 py-2 ui-meta text-text-faint">{t("views.repositories.addLocalHint")}</p>
        ) : (
          <>
            <Row label={t("views.repositories.rootDirLabel")}>
              <span className="max-w-full break-all font-mono ui-micro text-text-muted">{rootDir}</span>
            </Row>
            <Row label={t("views.repositories.repoIdLabel")} desc={t("views.repositories.repoIdHint")}>
              <input
                data-testid="add-local-repo-id"
                aria-label={t("views.repositories.repoIdLabel")}
                className="w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
                value={repoId}
                onChange={(event) => setRepoId(event.target.value)}
              />
            </Row>
            {mode === "bootstrap" ? (
              <>
                <Row label={t("views.repositories.personIdLabel")}>
                  <input
                    data-testid="add-local-person-id"
                    aria-label={t("views.repositories.personIdLabel")}
                    className="w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-meta text-text"
                    value={personId}
                    onChange={(event) => setPersonId(event.target.value)}
                  />
                </Row>
                <Row label={t("views.repositories.ownerNameLabel")}>
                  <input
                    data-testid="add-local-display-name"
                    aria-label={t("views.repositories.ownerNameLabel")}
                    className="w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-text"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </Row>
                <Row label={t("views.repositories.workspaceNameLabel")}>
                  <input
                    data-testid="add-local-workspace-name"
                    aria-label={t("views.repositories.workspaceNameLabel")}
                    className="w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Row>
                <Row label={t("views.repositories.addNpmScriptsLabel")}>
                  <input
                    type="checkbox"
                    checked={addNpmScripts}
                    onChange={(event) => setAddNpmScripts(event.target.checked)}
                  />
                </Row>
              </>
            ) : (
              <p className="px-3 py-1 ui-micro text-text-faint">{t("views.repositories.registerExistingHint")}</p>
            )}
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                data-testid={mode === "register" ? "add-local-register" : "add-local-bootstrap"}
                className={BTN}
                disabled={busy || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId.trim())}
                onClick={() => void (mode === "register" ? submitRegister() : submitBootstrap())}
              >
                {mode === "register"
                  ? busy
                    ? t("views.repositories.registerPending")
                    : t("views.repositories.registerAction")
                  : busy
                    ? t("views.repositories.bootstrapPending")
                    : t("views.repositories.bootstrapAction")}
              </button>
              <span className="ui-micro text-text-faint">
                {mode === "register"
                  ? t("views.repositories.registerExistingHint")
                  : t("views.repositories.bootstrapHint")}
              </span>
            </div>
          </>
        )}
        {feedback ? (
          <p data-testid="add-local-feedback" className="px-3 py-2 ui-meta text-status-blocked">
            {feedback}
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function firstRunApi(): FirstRunApi {
  const api = window.harness?.firstRun;
  if (!api) throw new Error("First-run preload bridge is unavailable.");
  return api;
}

function successfulBootstrap(value: unknown): value is { readonly ok: true } {
  return record(value) && value.ok === true;
}

function receiptHint(value: unknown): string {
  return record(value) && record(value.error) && typeof value.error.hint === "string"
    ? value.error.hint
    : "Repository initialization was rejected.";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
