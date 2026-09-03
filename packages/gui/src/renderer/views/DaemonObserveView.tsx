import { CaretLeft } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { DaemonTailPane, PANE_TOOL_BUTTON, type ObserveLogKind } from "../components/observe/DaemonTailPane.tsx";
import { useState } from "react";

/**
 * G6-B daemon 观察详情页:System→system 里点开某个 attached 仓库后的两栏实况。
 * 左栏 canonical 事件流,右栏日志流(每仓 repo-log ↔ 全局 daemon-log 可切);
 * 全部数据走 `observe.tail` RPC,GUI 不读文件。自动尾随滚动、可暂停、关键字过滤,
 * 事件行内的 task/decision/fact/session/provider/agent 引用可点跳转;
 * `unavailable` / `gap` 按契约原因显式呈现,不以空列表冒充。
 */

export function DaemonObserveView({
  repoId,
  repos,
  onBack,
  onNavigateEntity,
}: {
  readonly repoId: string | null;
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly onBack: () => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [logKind, setLogKind] = useState<ObserveLogKind>("repo-log"),
    repo = repos.find((row) => row.repoId === repoId) ?? null,
    label = repo?.displayName?.trim() || repoId || "",
    navigate = (ref: string) => onNavigateEntity(repoId === null ? ref : `repo/${repoId}/${ref}`);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <button type="button" onClick={onBack} data-testid="daemon-observe-back" className={PANE_TOOL_BUTTON}>
          <CaretLeft />
          {t("views.daemonObserve.backToSystem")}
        </button>
        <h1 className="ui-title font-semibold">{t("shell.nav.daemonObserve")}</h1>
        {repoId ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono ui-meta text-text" title={repoId}>
              {label}
            </span>
            {repo?.canonicalRoot ? (
              <span className="truncate font-mono ui-micro text-text-faint" title={repo.canonicalRoot}>
                {repo.canonicalRoot}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="font-mono ui-meta text-status-blocked">{t("views.daemonObserve.repoMissing")}</span>
        )}
      </header>
      {repoId === null ? null : (
        <div
          data-testid="daemon-observe-content"
          className="grid w-full min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-2"
        >
          <DaemonTailPane repoId={repoId} kind="events" onNavigateEntity={navigate} />
          <DaemonTailPane
            key={logKind}
            repoId={repoId}
            kind={logKind}
            kindOptions={[
              { value: "repo-log", label: t("views.daemonObserve.kindRepoLog") },
              {
                value: "daemon-log",
                label: t("views.daemonObserve.kindDaemonLog"),
                tip: t("views.daemonObserve.kindDaemonLogTip"),
              },
            ]}
            onKindChange={setLogKind}
            onNavigateEntity={navigate}
          />
        </div>
      )}
    </div>
  );
}
