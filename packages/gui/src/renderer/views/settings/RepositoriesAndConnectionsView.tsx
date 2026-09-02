import { useState } from "react";
import { Desktop, HardDrives, Plus, Sailboat } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { useConnectionsQuery } from "../../connection-data.ts";
import { RepoModeBadge } from "../../components/RepoModeBadge.tsx";
import { buildConnectionTree, connectionNodeId, type TreeSelection } from "./connectionTree.ts";
import { AddLocalRepositoryPanel } from "./AddLocalRepositoryPanel.tsx";
import { ConnectionDetailPanel } from "./ConnectionDetailPanel.tsx";
import { RepoDetailPanel } from "./RepoDetailPanel.tsx";

/**
 * Settings → 仓库与连接(PLT-EdgeGUI-W3,设计稿 §3.2):左列连接树(本机 / 远端端点 /
 * 中心占位),右侧详情。连接与仓库的 CRUD、启用停用、设为当前、模式切换都在
 * 详情面完成;所有写经 daemon admin RPC(主进程转发),GUI 内零远程 transport。
 * 首次运行的空态并入本页:无仓时详情面即「添加仓库 / 添加连接」引导。
 */
export function RepositoriesAndConnectionsView({
  repos,
  activeRepoId,
  onOpenProject,
}: {
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly onOpenProject: (repoId: string) => void;
}) {
  const connectionsQuery = useConnectionsQuery();
  const [selection, setSelection] = useState<TreeSelection>({ kind: "connection", id: "local" });
  const [addingConnection, setAddingConnection] = useState(false);
  const connections = connectionsQuery.data ?? [];
  const nodes = buildConnectionTree(connections, repos),
    selectedRepo = selection.kind === "repo" ? repos.find((repo) => repo.repoId === selection.repoId) : undefined;

  return (
    <div data-testid="repositories-connections-view" className="grid gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav
        data-testid="connection-tree"
        className="flex min-w-0 flex-col gap-1 self-start rounded-lg border border-border bg-surface p-2"
      >
        {nodes.map((node) => (
          <div key={node.nodeId} className="flex flex-col">
            <button
              type="button"
              data-testid={`connection-node-${node.nodeId}`}
              onClick={() => {
                setSelection(node.selection);
                setAddingConnection(false);
              }}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left ${
                selection.kind === "connection" && selection.id === node.nodeId && !addingConnection
                  ? "bg-surface-raised text-text"
                  : "text-text-muted hover:bg-surface-raised/50 hover:text-text"
              }`}
            >
              {node.nodeId === "local" ? (
                <Desktop weight="duotone" className="size-3.5 shrink-0" />
              ) : node.nodeId === "center" ? (
                <Sailboat weight="duotone" className="size-3.5 shrink-0" />
              ) : (
                <HardDrives weight="duotone" className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate ui-body font-medium">
                {node.nodeId === "local"
                  ? t("views.repositories.localConnection")
                  : node.nodeId === "center"
                    ? t("views.repositories.centerConnection")
                    : (node.connection?.displayName ?? node.nodeId)}
              </span>
              {node.connection?.state === "disabled" ? (
                <span className="font-mono ui-micro text-text-faint">{t("views.repositories.disabledMark")}</span>
              ) : null}
              {node.nodeId !== "center" ? (
                <span className="font-mono ui-micro text-text-faint">{node.repos.length}</span>
              ) : null}
            </button>
            <div className="ml-3 flex flex-col border-l border-border pl-1">
              {node.repos.map((repo) => (
                <button
                  key={repo.repoId}
                  type="button"
                  data-testid={`connection-repo-${repo.repoId}`}
                  onClick={() => {
                    setSelection({ kind: "repo", repoId: repo.repoId });
                    setAddingConnection(false);
                  }}
                  title={repo.repoId}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left ${
                    selection.kind === "repo" && selection.repoId === repo.repoId
                      ? "bg-surface-raised text-text"
                      : "text-text-muted hover:bg-surface-raised/50 hover:text-text"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate ui-meta">
                    {repo.displayName || repo.repoId}
                    {repo.registrationState === "disabled" ? (
                      <span className="ml-1 font-mono ui-micro text-text-faint">
                        {t("views.repositories.disabledMark")}
                      </span>
                    ) : null}
                  </span>
                  {repo.repoId === activeRepoId ? (
                    <span className="font-mono ui-micro text-accent">{t("views.repositories.currentMark")}</span>
                  ) : null}
                  <RepoModeBadge mode={repo.mode} />
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          type="button"
          data-testid="connection-add-open"
          onClick={() => {
            setAddingConnection(true);
            setSelection({ kind: "connection", id: "local" });
          }}
          className={
            "mt-1 flex items-center gap-1.5 rounded-md border border-dashed " +
            "border-border px-2 py-1.5 ui-meta text-text-muted hover:border-border-strong hover:text-text"
          }
        >
          <Plus weight="bold" className="size-3.5 shrink-0" />
          {t("views.repositories.addConnection")}
        </button>
        {connectionsQuery.isError ? (
          <p data-testid="connection-tree-error" className="px-2 py-1 ui-micro text-status-blocked">
            {connectionsQuery.error instanceof Error ? connectionsQuery.error.message : String(connectionsQuery.error)}
          </p>
        ) : null}
      </nav>

      <div className="min-w-0">
        {addingConnection ? (
          <ConnectionDetailPanel
            mode="add"
            connection={null}
            repos={[]}
            allRepoIds={repos.map((repo) => repo.repoId)}
            onDone={() => {
              setAddingConnection(false);
              setSelection({ kind: "connection", id: "local" });
            }}
          />
        ) : selectedRepo ? (
          <RepoDetailPanel
            repo={selectedRepo}
            isCurrent={selectedRepo.repoId === activeRepoId}
            connections={connections}
            onOpenProject={onOpenProject}
          />
        ) : (
          (() => {
            const node = nodes.find(
              (candidate) => selection.kind === "connection" && candidate.nodeId === selection.id,
            );
            if (!node) return null;
            if (node.nodeId === "local")
              return (
                <AddLocalRepositoryPanel repos={node.repos} onOpenProject={onOpenProject} activeRepoId={activeRepoId} />
              );
            if (node.nodeId === "center") return <CenterConnectionPanel connections={connections} repos={node.repos} />;
            return (
              <ConnectionDetailPanel
                mode="edit"
                connection={node.connection}
                repos={node.repos}
                allRepoIds={repos.map((repo) => repo.repoId)}
                onDone={() => setSelection({ kind: "connection", id: "local" })}
              />
            );
          })()
        )}
      </div>
    </div>
  );
}

/** 中心连接占位(设计稿 §3.2:只读展示既有 fleet 配置摘要 + CLI 提示,无 CRUD)。 */
function CenterConnectionPanel({
  connections,
  repos,
}: {
  readonly connections: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly displayName: string }>;
  readonly repos: readonly SystemRepoRow[];
}) {
  const centers = connections.filter((connection) => connection.kind === "fleet-center");
  return (
    <section data-testid="center-connection-panel" className="rounded-lg border border-border bg-surface">
      <div className="border-b border-border px-3 py-1.5 font-mono ui-meta uppercase tracking-wide text-text-faint">
        {t("views.repositories.centerConnection")}
      </div>
      <div className="px-3 py-2 ui-meta text-text-muted">{t("views.repositories.centerPlaceholderSummary")}</div>
      <dl className="grid gap-2 px-3 pb-2">
        <div>
          <dt className="font-mono ui-micro uppercase text-text-faint">{t("views.repositories.centerConnections")}</dt>
          <dd className="font-mono ui-meta text-text-muted">
            {centers.length === 0
              ? t("views.repositories.centerNone")
              : centers.map((connection) => connection.displayName).join(", ")}
          </dd>
        </div>
        <div>
          <dt className="font-mono ui-micro uppercase text-text-faint">{t("views.repositories.centerRepos")}</dt>
          <dd className="font-mono ui-meta text-text-muted">
            {repos.length === 0
              ? t("views.repositories.centerNone")
              : repos.map((repo) => `${repo.repoId} (${repo.mode})`).join(", ")}
          </dd>
        </div>
      </dl>
      <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono ui-micro text-text-faint">
        {t("views.repositories.centerCliHint")}
      </pre>
    </section>
  );
}

export { connectionNodeId };
