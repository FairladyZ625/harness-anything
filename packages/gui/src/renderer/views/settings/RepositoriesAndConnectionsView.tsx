import { useEffect, useState } from "react";
import { Desktop, HardDrives, Plus, Sailboat, UserPlus } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { useConnectionsQuery } from "../../connection-data.ts";
import { RepoModeBadge } from "../../components/RepoModeBadge.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { BoundedContent } from "../../components/primitives/BoundedContent.tsx";
import {
  buildConnectionTree,
  connectionNodeId,
  invitationRepos,
  type ConnectionTreeNode,
  type TreeSelection,
} from "./connectionTree.ts";
import { AddLocalRepositoryPanel } from "./AddLocalRepositoryPanel.tsx";
import { ConnectionDetailPanel } from "./ConnectionDetailPanel.tsx";
import { InviteMembersSurface } from "./InviteMembersSurface.tsx";
import { RepoDetailPanel } from "./RepoDetailPanel.tsx";
import { guiHostBridge } from "../../gui-transport.ts";
import type { CertificateMode, CenterListenerSettings } from "../../../api/center-settings-contract.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";

/**
 * Settings → 仓库与连接(PLT-EdgeGUI-W3,设计稿 §3.2):左列连接树(本机 / 远端端点 /
 * 中心),右侧详情。连接与仓库的 CRUD、启用停用、设为当前、模式切换都在详情面完成;
 * 所有写经 daemon admin RPC(主进程转发),GUI 内零远程 transport。
 * 首次运行的空态并入本页:无仓时详情面即「添加仓库 / 添加连接」引导。
 *
 * 页顶另有一条独立入口「邀请成员加入」:邀请是发给别人的动作,不该要求先理解
 * 「中心节点」这个概念,也不该藏在证书设置下面(task_aebe0026)。点开直接进邀请面板。
 */
export function RepositoriesAndConnectionsView({
  repos,
  activeRepoId,
  onOpenProject,
  onJoinCenter,
}: {
  readonly repos: readonly SystemRepoRow[];
  readonly activeRepoId: string | null;
  readonly onOpenProject: (repoId: string) => void;
  /** 打开「加入中心」向导;本机连接空状态的入口(task_0499bcc75d0f)。 */
  readonly onJoinCenter: () => void;
}) {
  const connectionsQuery = useConnectionsQuery();
  const [selection, setSelection] = useState<TreeSelection>({ kind: "connection", id: "local" });
  const [addingConnection, setAddingConnection] = useState(false);
  const connections = connectionsQuery.data ?? [];
  const nodes = buildConnectionTree(connections, repos),
    selectedRepo = selection.kind === "repo" ? repos.find((repo) => repo.repoId === selection.repoId) : undefined,
    inviteSelected = selection.kind === "invite",
    invitationRepositories = invitationRepos(repos);
  const openInvite = () => {
    setSelection({ kind: "invite" });
    setAddingConnection(false);
  };

  const centerNode = nodes.find((node) => node.nodeId === "center"),
    scrollNodes = nodes.filter((node) => node.nodeId !== "center"),
    selectedConnectionId = selection.kind === "connection" && !addingConnection ? selection.id : null;
  const selectConnection = (node: ConnectionTreeNode) => {
    setSelection(node.selection);
    setAddingConnection(false);
  };
  const selectRepo = (repoId: string) => {
    setSelection({ kind: "repo", repoId });
    setAddingConnection(false);
  };

  return (
    <div data-testid="repositories-connections-view" className="flex flex-col gap-3">
      <section
        data-testid="invite-entry"
        className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${
          inviteSelected ? "border-border-strong bg-surface-raised" : "border-border bg-surface"
        }`}
      >
        <UserPlus weight="duotone" className="size-5 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="ui-body font-semibold">{t("views.repositories.inviteEntryTitle")}</h2>
          <p className="mt-0.5 ui-meta text-text-muted">{t("views.repositories.inviteEntrySummary")}</p>
        </div>
        <Button variant={inviteSelected ? "ghost" : "primary"} testId="invite-entry-open" onClick={openInvite}>
          {t("views.repositories.inviteEntryAction")}
        </Button>
      </section>

      <div className="grid gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* 15rem 是应用顶栏 + 设置页头 + 页顶入口 + 页内边距的呼吸位;它只把树封顶到首屏内,
            树里再多内容也只在树内滚动,不把树底的中心行与「添加连接」推出视口。 */}
        <nav
          data-testid="connection-tree"
          className={
            "flex min-w-0 flex-col gap-1 self-start rounded-lg border border-border bg-surface p-2 " +
            "lg:sticky lg:top-3 lg:max-h-[calc(100dvh-15rem)]"
          }
        >
          {/* 连接行始终可见:仓库再多,也只让仓库列表在树内滚动,不再把中心节点整行推出视口。 */}
          <div
            data-testid="connection-tree-scroll"
            className="scroll-fade-y flex min-h-0 shrink flex-col gap-1 overflow-y-auto"
          >
            {scrollNodes.map((node) => (
              <ConnectionTreeNode
                key={node.nodeId}
                node={node}
                selectedConnectionId={selectedConnectionId}
                selectedRepoId={selection.kind === "repo" ? selection.repoId : null}
                activeRepoId={activeRepoId}
                onSelectConnection={selectConnection}
                onSelectRepo={selectRepo}
              />
            ))}
          </div>
          {/* 中心节点与「添加连接」钉在树底:两者都是离开本页的动作,不能被仓库列表滚走。 */}
          <div data-testid="connection-tree-footer" className="flex shrink-0 flex-col gap-1">
            {centerNode ? (
              <ConnectionTreeNode
                node={centerNode}
                selectedConnectionId={selectedConnectionId}
                selectedRepoId={selection.kind === "repo" ? selection.repoId : null}
                activeRepoId={activeRepoId}
                boundedChildren
                onSelectConnection={selectConnection}
                onSelectRepo={selectRepo}
              />
            ) : null}
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
                {connectionsQuery.error instanceof Error
                  ? connectionsQuery.error.message
                  : String(connectionsQuery.error)}
              </p>
            ) : null}
          </div>
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
          ) : inviteSelected ? (
            <InviteMembersSurface
              repos={invitationRepositories}
              onConfigureLogin={() => setSelection({ kind: "connection", id: "center" })}
            />
          ) : (
            (() => {
              const node = nodes.find(
                (candidate) => selection.kind === "connection" && candidate.nodeId === selection.id,
              );
              if (!node) return null;
              if (node.nodeId === "local")
                return (
                  <AddLocalRepositoryPanel
                    repos={node.repos}
                    onOpenProject={onOpenProject}
                    activeRepoId={activeRepoId}
                    onJoinCenter={onJoinCenter}
                  />
                );
              if (node.nodeId === "center")
                return <CenterConnectionPanel connections={connections} repos={node.repos} onInvite={openInvite} />;
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
    </div>
  );
}

/**
 * 一个连接行及其仓库列表:行本身永远可见,仓库列表才是可能变长的那部分。
 * 中心行的仓库列表固定在树底,所以给它接共享长内容边界(`--long-content-cap`),
 * 仓库再多也只在自己的区域里滚动,不会把「添加连接」推出视口。
 */
function ConnectionTreeNode({
  node,
  selectedConnectionId,
  selectedRepoId,
  activeRepoId,
  boundedChildren = false,
  onSelectConnection,
  onSelectRepo,
}: {
  readonly node: ConnectionTreeNode;
  readonly selectedConnectionId: string | null;
  readonly selectedRepoId: string | null;
  readonly activeRepoId: string | null;
  readonly boundedChildren?: boolean;
  readonly onSelectConnection: (node: ConnectionTreeNode) => void;
  readonly onSelectRepo: (repoId: string) => void;
}) {
  const selected = selectedConnectionId === node.nodeId;
  const repoRows = (
    <>
      {node.repos.map((repo) => (
        <button
          key={repo.repoId}
          type="button"
          data-testid={`connection-repo-${repo.repoId}`}
          onClick={() => onSelectRepo(repo.repoId)}
          title={repo.repoId}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left ${
            selectedRepoId === repo.repoId
              ? "bg-surface-raised text-text"
              : "text-text-muted hover:bg-surface-raised/50 hover:text-text"
          }`}
        >
          <span className="min-w-0 flex-1 truncate ui-meta">
            {repo.displayName || repo.repoId}
            {repo.registrationState === "disabled" ? (
              <span className="ml-1 font-mono ui-micro text-text-faint">{t("views.repositories.disabledMark")}</span>
            ) : null}
          </span>
          {repo.repoId === activeRepoId ? (
            <span className="font-mono ui-micro text-accent">{t("views.repositories.currentMark")}</span>
          ) : null}
          <RepoModeBadge mode={repo.mode} />
        </button>
      ))}
    </>
  );
  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-testid={`connection-node-${node.nodeId}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelectConnection(node)}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left ${
          selected ? "bg-surface-raised text-text" : "text-text-muted hover:bg-surface-raised/50 hover:text-text"
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
        {/* 每行都有仓库数(中心行也一样):缺了计数的行看起来像分组标题,而不像可点的连接。 */}
        <span data-testid={`connection-node-count-${node.nodeId}`} className="font-mono ui-micro text-text-faint">
          {node.repos.length}
        </span>
      </button>
      {boundedChildren ? (
        <BoundedContent className="ml-3 flex flex-col border-l border-border pl-1">{repoRows}</BoundedContent>
      ) : (
        <div className="ml-3 flex flex-col border-l border-border pl-1">{repoRows}</div>
      )}
    </div>
  );
}

/**
 * 中心连接面板(设计稿 §3.2):中心登录服务证书由 daemon 持久化,renderer 只传文件路径,
 * 私钥内容永远不进入 GUI。邀请不再挂在这里:它有自己的页顶入口和详情面(task_aebe0026),
 * 本面板只保留证书与中心连接事实,并给不熟悉「中心节点」的人一条去邀请的次入口。
 */
function CenterConnectionPanel({
  connections,
  repos,
  onInvite,
}: {
  readonly connections: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly displayName: string }>;
  readonly repos: readonly SystemRepoRow[];
  readonly onInvite: () => void;
}) {
  const centers = connections.filter((connection) => connection.kind === "fleet-center");
  const centerSettings = guiHostBridge()?.centerSettings;
  const [settings, setSettings] = useState<CenterListenerSettings | null>(null);
  const [mode, setMode] = useState<CertificateMode>("self-signed");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("8443");
  const [certificateFile, setCertificateFile] = useState("");
  const [certificateKeyFile, setCertificateKeyFile] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!centerSettings) return;
    void Promise.all([centerSettings.listener(), centerSettings.externalAddress()])
      .then(([value, address]) => {
        setSettings(value);
        setMode(value.certificateMode);
        setHostname(value.listener?.hostname ?? "");
        setPort(String(value.listener?.port ?? 8443));
        setCertificateFile(value.listener?.certificateFile ?? "");
        setExternalUrl(address.externalUrl ?? "");
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
        consumeKnownError(error);
      });
  }, [centerSettings]);
  const selectFile = async (kind: "certificate" | "private-key") => {
    if (!centerSettings) return;
    try {
      const selected = await centerSettings.selectFile(kind);
      if (selected === null) return;
      if (kind === "certificate") setCertificateFile(selected);
      else setCertificateKeyFile(selected);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
      consumeKnownError(error);
    }
  };
  const saveCertificate = async () => {
    if (!centerSettings || !settings) return;
    setSaving(true);
    setStatus(null);
    try {
      const normalizedHostname = hostname.trim();
      const result = await centerSettings.setCertificate({
        expectedVersion: settings.version,
        certificateMode: mode,
        ...(normalizedHostname ? { hostname: normalizedHostname } : {}),
        port: Number(port),
        ...(mode === "self-signed"
          ? {}
          : {
              certificateFile,
              certificateKeyFile,
            }),
      });
      if (
        typeof result === "object" &&
        result !== null &&
        "code" in result &&
        (result as { code?: unknown }).code === "version_conflict"
      ) {
        setStatus(t("views.repositories.centerCertificateConflict"));
        return;
      }
      setStatus(t("views.repositories.centerCertificateSaved"));
      const refreshed = await centerSettings.listener();
      setSettings(refreshed);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
      consumeKnownError(error);
    } finally {
      setSaving(false);
    }
  };
  const saveExternalAddress = async () => {
    if (!centerSettings) return;
    setSaving(true);
    setStatus(null);
    try {
      const result = await centerSettings.setExternalAddress({ externalUrl: externalUrl.trim() });
      setStatus(result.warning || t("views.repositories.centerExternalAddressSaved"));
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
      consumeKnownError(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <section data-testid="center-connection-panel" className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-3 py-1.5 font-mono ui-meta uppercase tracking-wide text-text-faint">
          {t("views.repositories.centerConnection")}
        </div>
        <div className="px-3 py-2 ui-meta text-text-muted">{t("views.repositories.centerCertificateSummary")}</div>
        <dl className="grid gap-2 px-3 pb-2">
          <div>
            <dt className="font-mono ui-micro uppercase text-text-faint">
              {t("views.repositories.centerConnections")}
            </dt>
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
        <div className="border-t border-border px-3 py-3">
          <h3 className="ui-meta font-medium text-text">{t("views.repositories.centerExternalAddressTitle")}</h3>
          <p className="mt-1 ui-micro text-text-muted">{t("views.repositories.centerExternalAddressHint")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              type="url"
              data-testid="center-external-address"
              className="min-w-[18rem] flex-1 rounded border border-border bg-surface px-2 py-1 font-mono ui-meta"
              value={externalUrl}
              onChange={(event) => setExternalUrl(event.target.value)}
              placeholder="https://center.example.com:7545"
            />
            {centerSettings ? (
              <button
                type="button"
                data-testid="center-external-address-save"
                disabled={saving || externalUrl.trim() === ""}
                className="rounded bg-accent px-3 py-1.5 ui-meta text-white disabled:opacity-50"
                onClick={() => void saveExternalAddress()}
              >
                {saving
                  ? t("views.repositories.centerExternalAddressSaving")
                  : t("views.repositories.centerExternalAddressSave")}
              </button>
            ) : null}
          </div>
          <h3 className="ui-meta font-medium text-text">{t("views.repositories.centerCertificateTitle")}</h3>
          <p className="mt-1 ui-micro text-text-muted">{t("views.repositories.centerLoginAddressHint")}</p>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Login service certificate type">
            {(
              [
                [
                  "self-signed",
                  t("views.repositories.centerCertificateSelfSigned"),
                  t("views.repositories.centerCertificateSelfSignedHint"),
                ],
                [
                  "domain",
                  t("views.repositories.centerCertificateDomain"),
                  t("views.repositories.centerCertificateDomainHint"),
                ],
                [
                  "internal-ca",
                  t("views.repositories.centerCertificateInternalCa"),
                  t("views.repositories.centerCertificateInternalCaHint"),
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className="flex min-w-[12rem] flex-1 cursor-pointer gap-2 rounded-md border border-border p-2"
              >
                <input
                  type="radio"
                  name="center-certificate-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>
                  <span className="block ui-meta font-medium">{label}</span>
                  <span className="block ui-micro text-text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="ui-meta">
              {t("views.repositories.centerCertificateHostname")}
              <input
                data-testid="center-login-hostname"
                className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1"
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="login.example.com"
              />
            </label>
            <label className="ui-meta">
              {t("views.repositories.centerCertificatePort")}
              <input
                data-testid="center-login-port"
                className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                inputMode="numeric"
              />
            </label>
            {mode !== "self-signed" ? (
              <>
                <div className="ui-meta">
                  {t("views.repositories.centerCertificateFile")}
                  <div className="mt-1 flex gap-2">
                    <span className="min-w-0 flex-1 truncate rounded border border-border px-2 py-1 font-mono ui-micro">
                      {certificateFile || t("views.repositories.centerCertificateNoFile")}
                    </span>
                    <button
                      type="button"
                      data-testid="center-certificate-file-choose"
                      className="rounded border border-border px-2 py-1"
                      onClick={() => void selectFile("certificate")}
                    >
                      {t("views.repositories.centerCertificateChoose")}
                    </button>
                  </div>
                </div>
                <div className="ui-meta">
                  {t("views.repositories.centerCertificateKey")}
                  <div className="mt-1 flex gap-2">
                    <span className="min-w-0 flex-1 truncate rounded border border-border px-2 py-1 font-mono ui-micro">
                      {certificateKeyFile
                        ? t("views.repositories.centerCertificateSelected")
                        : t("views.repositories.centerCertificateNoFile")}
                    </span>
                    <button
                      type="button"
                      data-testid="center-certificate-key-choose"
                      className="rounded border border-border px-2 py-1"
                      onClick={() => void selectFile("private-key")}
                    >
                      {t("views.repositories.centerCertificateChoose")}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          {mode === "self-signed" ? (
            <p className="mt-2 ui-micro text-text-muted">{t("views.repositories.centerCertificateGeneratedHint")}</p>
          ) : null}
          {centerSettings ? (
            <button
              type="button"
              data-testid="center-certificate-save"
              disabled={saving || !settings}
              className="mt-3 rounded bg-accent px-3 py-1.5 ui-meta text-white disabled:opacity-50"
              onClick={() => void saveCertificate()}
            >
              {saving ? t("views.repositories.centerCertificateSaving") : t("views.repositories.centerCertificateSave")}
            </button>
          ) : null}
          {status ? (
            <p className="mt-2 ui-micro text-text-muted" role="status">
              {status}
            </p>
          ) : null}
        </div>
        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            data-testid="center-panel-open-invite"
            className="ui-meta text-accent hover:underline"
            onClick={onInvite}
          >
            {t("views.repositories.inviteEntryFromCenter")}
          </button>
        </div>
      </section>
    </div>
  );
}

export { connectionNodeId };
