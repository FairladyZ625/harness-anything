import { useQuery } from "@tanstack/react-query";
import { Sailboat, UserPlus } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { guiHostBridge } from "../../gui-transport.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { EdgeInvitePanel } from "./EdgeInvitePanel.tsx";
import { centerReadiness } from "./centerReadiness.ts";

/**
 * 「邀请成员加入」的详情面:入口在页顶(RepositoriesAndConnectionsView),点开直接到这里。
 *
 * 面板本身仍是 EdgeInvitePanel —— 不另起一套邀请实现。这里只补前置判断:邀请链接把登录地址
 * 一起发给对方,所以本机还没有登录服务证书时,先把缺的那一步说出来并给出一个按钮,
 * 而不是让人填完表单才在签发时撞上 daemon 的拒绝。
 */
export function InviteMembersSurface({
  repos,
  onConfigureLogin,
}: {
  readonly repos: readonly SystemRepoRow[];
  /** 去「中心节点」配置登录服务证书。 */
  readonly onConfigureLogin: () => void;
}) {
  const centerSettings = guiHostBridge()?.centerSettings;
  const listener = useQuery({
    queryKey: ["center", "listener"],
    queryFn: () => centerSettings!.listener(),
    enabled: centerSettings !== undefined,
  });
  // 没有本机设置桥(浏览器调试面)时没有可判断的前置,直接把表单交出去,由 daemon 兜底说明。
  if (centerSettings === undefined) return <EdgeInvitePanel repos={repos} />;
  if (listener.isPending)
    return (
      <p data-testid="invite-entry-checking" className="px-1 py-2 ui-meta text-text-faint">
        {t("views.repositories.inviteEntryChecking")}
      </p>
    );
  const failure = listener.error as { readonly code?: unknown } | null;
  const readiness = centerReadiness(
    listener.isError
      ? { ok: false, ...(typeof failure?.code === "string" ? { code: failure.code } : {}) }
      : listener.data,
  );
  if (readiness.state === "ready") return <EdgeInvitePanel repos={repos} />;
  return (
    <section
      data-testid="invite-entry-blocked"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start gap-2">
        <Sailboat weight="duotone" className="mt-0.5 size-5 shrink-0 text-text-muted" />
        <div className="min-w-0">
          <h2 className="ui-body font-semibold">{t("views.repositories.inviteEntryBlockedTitle")}</h2>
          <p className="mt-1 ui-meta text-text-muted">
            {readiness.reason === "certificate-unconfigured"
              ? t("views.repositories.inviteEntryBlockedCertificate")
              : t("views.repositories.inviteEntryBlockedLogin")}
          </p>
        </div>
      </div>
      <div>
        <Button variant="primary" testId="invite-entry-configure" onClick={onConfigureLogin}>
          <UserPlus className="mr-1 inline size-3.5" />
          {t("views.repositories.inviteEntryConfigure")}
        </Button>
      </div>
    </section>
  );
}
