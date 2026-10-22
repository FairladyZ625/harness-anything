import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Sailboat, UserPlus } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import type { CenterStartInput } from "../../../api/center-settings-contract.ts";
import { t } from "../../i18n/index.tsx";
import { guiHostBridge } from "../../gui-transport.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { EdgeInvitePanel } from "./EdgeInvitePanel.tsx";
import { centerReadiness } from "./centerReadiness.ts";
import { centerServiceState, centerStartDefaults } from "./centerService.ts";

/**
 * 「邀请成员加入」的详情面:入口在页顶(RepositoriesAndConnectionsView),点开直接到这里。
 *
 * 面板本身仍是 EdgeInvitePanel —— 不另起一套邀请实现。这里只补前置判断,按边缘接入的真实
 * 依赖顺序拦:①登录服务证书(邀请链接把登录地址一起发给对方);②中心 TLS 服务(邀请携带的
 * 中心地址必须真的在监听)。缺哪步就把缺的那一步说出来:登录证书缺失给一个去中心面板的按钮,
 * 中心服务未开给一键开启(参数从保存的配置/登录主机名推导,证书由 daemon 沿用登录服务的那对,
 * 界面不出现 key/cert);推导不出唯一权威仓时退回导航按钮,不猜。
 */
export function InviteMembersSurface({
  repos,
  onConfigureLogin,
}: {
  readonly repos: readonly SystemRepoRow[];
  /** 去「中心节点」配置登录服务证书 / 中心服务。 */
  readonly onConfigureLogin: () => void;
}) {
  const centerSettings = guiHostBridge()?.centerSettings;
  const queryClient = useQueryClient();
  const listener = useQuery({
    queryKey: ["center", "listener"],
    queryFn: () => centerSettings!.listener(),
    enabled: centerSettings !== undefined,
  });
  const fleetStatus = useQuery({
    queryKey: ["center", "fleet-status"],
    queryFn: () => centerSettings!.fleetStatus(),
    enabled: centerSettings !== undefined,
  });
  const startCenter = useMutation({
    mutationFn: (input: CenterStartInput) => centerSettings!.startCenter(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["center", "fleet-status"] });
    },
  });
  // 没有本机设置桥(浏览器调试面)时没有可判断的前置,直接把表单交出去,由 daemon 兜底说明。
  if (centerSettings === undefined) return <EdgeInvitePanel repos={repos} />;
  const failure = listener.error as { readonly code?: unknown } | null;
  const readiness = centerReadiness(
    listener.isError
      ? { ok: false, ...(typeof failure?.code === "string" ? { code: failure.code } : {}) }
      : listener.data,
  );
  const service = centerServiceState(fleetStatus.data);
  if (readiness.state === "ready" && service.state === "running") return <EdgeInvitePanel repos={repos} />;
  if (readiness.state === "ready" && fleetStatus.isPending)
    return (
      <p data-testid="invite-entry-checking" className="px-1 py-2 ui-meta text-text-faint">
        {t("views.repositories.inviteEntryChecking")}
      </p>
    );
  if (readiness.state === "ready" && service.state === "unknown")
    // 状态读失败不是「服务未开」的证据:表单照常可用,daemon 的签发拒绝会点名真实问题。
    return <EdgeInvitePanel repos={repos} />;
  const loginBlocked = readiness.state === "missing";
  // 一键开启的参数推导:保存的配置优先,否则唯一 local 仓 + 登录主机名;推不出就只给导航。
  const oneClick = loginBlocked
    ? null
    : centerStartDefaults({
        status: fleetStatus.data,
        loginHostname:
          listener.data !== undefined && listener.data.ok === true && listener.data.listener !== null
            ? listener.data.listener.hostname
            : null,
        localRepoIds: repos
          .filter(
            (repo) => repo.registrationState === "enabled" && repo.canonicalRoot !== null && repo.mode === "local",
          )
          .map((repo) => repo.repoId),
      });
  return (
    <section
      data-testid={loginBlocked ? "invite-entry-blocked" : "invite-entry-blocked-service"}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start gap-2">
        <Sailboat weight="duotone" className="mt-0.5 size-5 shrink-0 text-text-muted" />
        <div className="min-w-0">
          <h2 className="ui-body font-semibold">
            {loginBlocked
              ? t("views.repositories.inviteEntryBlockedTitle")
              : t("views.repositories.inviteEntryBlockedServiceTitle")}
          </h2>
          <p className="mt-1 ui-meta text-text-muted">
            {loginBlocked
              ? readiness.reason === "certificate-unconfigured"
                ? t("views.repositories.inviteEntryBlockedCertificate")
                : t("views.repositories.inviteEntryBlockedLogin")
              : t("views.repositories.inviteEntryBlockedService")}
          </p>
        </div>
      </div>
      {loginBlocked || !startCenter.isError ? null : (
        <p className="ui-micro text-status-blocked" role="status">
          {startCenter.error instanceof Error ? startCenter.error.message : String(startCenter.error)}
        </p>
      )}
      <div>
        {loginBlocked ? (
          <Button variant="primary" testId="invite-entry-configure" onClick={onConfigureLogin}>
            <UserPlus className="mr-1 inline size-3.5" />
            {t("views.repositories.inviteEntryConfigure")}
          </Button>
        ) : oneClick !== null ? (
          <Button
            variant="primary"
            testId="invite-entry-start-center"
            disabled={startCenter.isPending}
            onClick={() => oneClick !== null && startCenter.mutate(oneClick)}
          >
            <Play className="mr-1 inline size-3.5" />
            {startCenter.isPending
              ? t("views.repositories.inviteEntryStarting")
              : t("views.repositories.inviteEntryStartCenter")}
          </Button>
        ) : (
          <Button variant="primary" testId="invite-entry-open-center" onClick={onConfigureLogin}>
            <Sailboat className="mr-1 inline size-3.5" />
            {t("views.repositories.inviteEntryOpenCenter")}
          </Button>
        )}
      </div>
    </section>
  );
}
