import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { t } from "../../i18n/index.tsx";
import { QUERY_PACING_MS } from "../../query-pacing.ts";
import { fetchEdgeJoinStatus, issueEdgeJoin } from "../../edge-invite-client.ts";
import type { EdgeJoinStatusReply } from "../../../api/access-admin-contract.ts";
import { CopyContextButton } from "../../components/CopyContextButton.tsx";
import { Row } from "../../components/ui/widgets.tsx";
import { Section } from "../../components/primitives/Section.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { formatTime } from "../../model/time.ts";

/**
 * 中心节点的「邀请边缘节点」入口(task gui-edge-invite):节点名交给 daemon 的
 * edge-join-create 签发——GUI 不另写签发逻辑,授权与序列化都在 daemon,证书指纹也由
 * daemon 读自己的监听证书算出,这里没有指纹输入。链接是凭据:inviteLink 只存在于本组件
 * 内存,「完成」即从 DOM 与内存清除;会话内保留的行只有 joinId/nodeId 与状态,状态轮询
 * 按 inviteId 查(有效期也来自状态回执),链接不需要在场。中心地址留空时由 daemon 按监听
 * 配置推导,填写即覆盖,表单里保留方便批量签发。
 */

const INPUT_CLASS = [
  "w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1",
  "font-mono ui-meta text-text",
].join(" ");

interface IssuedInvite {
  readonly joinId: string;
  readonly nodeId: string;
  /** 只在签出到「完成」之间存在;关掉就再也取不出来。 */
  inviteLink?: string;
}

const statusTone = { pending: "wait", consumed: "done", expired: "bad" } as const;

export function EdgeInvitePanel() {
  const [nodeId, setNodeId] = useState(""),
    [centerUrl, setCenterUrl] = useState(""),
    [feedback, setFeedback] = useState<string | null>(null),
    [invites, setInvites] = useState<readonly IssuedInvite[]>([]),
    [statuses, setStatuses] = useState<Readonly<Record<string, EdgeJoinStatusReply>>>({});
  const issue = useMutation({ mutationFn: issueEdgeJoin });

  // 只轮询未到终态的邀请;key 随集合变化,全部终态后 refetchInterval 返回 false 停表。
  const openInviteIds = invites
    .filter((invite) => statuses[invite.joinId]?.status !== "consumed" && statuses[invite.joinId]?.status !== "expired")
    .map((invite) => invite.joinId);
  const statusQuery = useQuery({
    queryKey: ["edge-join", "status", ...[...openInviteIds].sort()],
    enabled: openInviteIds.length > 0,
    queryFn: async () => await Promise.all(openInviteIds.map((joinId) => fetchEdgeJoinStatus(joinId))),
    refetchInterval: (query) =>
      query.state.data?.every((row) => row.status !== "pending") ? false : QUERY_PACING_MS.edgeJoinStatus,
  });
  useEffect(() => {
    if (!statusQuery.data) return;
    setStatuses((current) => {
      const next = { ...current };
      for (const row of statusQuery.data!) next[row.inviteId] = row;
      return next;
    });
  }, [statusQuery.data]);

  const submit = () => {
    setFeedback(null);
    if (nodeId.trim().length === 0) {
      setFeedback(t("views.repositories.inviteFieldsRequired"));
      return;
    }
    issue.mutate(
      {
        nodeId: nodeId.trim(),
        ...(centerUrl.trim() ? { centerUrl: centerUrl.trim() } : {}),
      },
      {
        onSuccess: (issued) => {
          setInvites((current) => [
            {
              joinId: issued.joinId,
              nodeId: nodeId.trim(),
              inviteLink: issued.inviteLink,
            },
            ...current,
          ]);
          // 中心地址是可选覆盖,留给下一张邀请;只有节点名需要重填。
          setNodeId("");
        },
        onError: (error) => {
          setFeedback(error instanceof Error ? error.message : String(error));
        },
      },
    );
  };

  const dismissLink = (joinId: string) =>
    setInvites((current) => current.map((row) => (row.joinId === joinId ? { ...row, inviteLink: undefined } : row)));

  return (
    <Section
      variant="panel"
      title={t("views.repositories.inviteTitle")}
      note={t("views.repositories.inviteSummary")}
      action={
        <Button testId="edge-invite-issue" disabled={issue.isPending} onClick={submit}>
          {issue.isPending ? t("views.repositories.invitePending") : t("views.repositories.inviteAction")}
        </Button>
      }
    >
      <Row label={t("views.repositories.inviteNodeIdLabel")}>
        <input
          data-testid="edge-invite-node-id"
          aria-label={t("views.repositories.inviteNodeIdLabel")}
          className={INPUT_CLASS}
          value={nodeId}
          placeholder="edge-a"
          onChange={(event) => setNodeId(event.target.value)}
        />
      </Row>
      <Row label={t("views.repositories.inviteCenterUrlLabel")} desc={t("views.repositories.inviteCenterUrlHint")}>
        <input
          data-testid="edge-invite-center-url"
          aria-label={t("views.repositories.inviteCenterUrlLabel")}
          className={INPUT_CLASS}
          placeholder="https://center.example.com:8443"
          value={centerUrl}
          onChange={(event) => setCenterUrl(event.target.value)}
        />
      </Row>
      {feedback ? (
        <p data-testid="edge-invite-feedback" className="px-3 py-2 ui-meta text-status-blocked">
          {feedback}
        </p>
      ) : null}
      {invites.length > 0 ? (
        <div className="border-t border-border px-3 py-2">
          <p className="ui-meta text-text-faint">{t("views.repositories.inviteIssuedTitle")}</p>
          <ul data-testid="edge-invite-list" className="mt-1 flex flex-col gap-2">
            {invites.map((invite) => {
              const status = statuses[invite.joinId];
              return (
                <li
                  key={invite.joinId}
                  data-testid={`edge-invite-row-${invite.nodeId}`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono ui-meta">{invite.nodeId}</span>
                    {status ? (
                      <StatusTag
                        tone={statusTone[status.status]}
                        label={t(`views.repositories.inviteStatus.${status.status}`)}
                      />
                    ) : (
                      <span className="ui-micro text-text-faint">{t("views.repositories.inviteStatusUnknown")}</span>
                    )}
                    {status ? (
                      <span className="ml-auto shrink-0 font-mono ui-micro text-text-faint">
                        {t("views.repositories.inviteExpires")}
                        {formatTime(status.expiresAt, { style: "date-time" }) ?? status.expiresAt}
                      </span>
                    ) : null}
                  </div>
                  {invite.inviteLink ? (
                    <div data-testid={`edge-invite-link-${invite.nodeId}`} className="flex flex-col gap-1">
                      <p className="ui-micro text-status-submitted">{t("views.repositories.inviteLinkHint")}</p>
                      <code className="max-w-full overflow-x-auto whitespace-nowrap rounded border border-border bg-surface-raised px-2 py-1 font-mono ui-micro text-text">
                        {invite.inviteLink}
                      </code>
                      <div className="flex items-center gap-2">
                        <CopyContextButton
                          testId={`edge-invite-copy-${invite.nodeId}`}
                          label={t("views.repositories.inviteCopyAction")}
                          title={t("views.repositories.inviteCopyTitle")}
                          compact
                          buildText={() => invite.inviteLink ?? ""}
                        />
                        <Button
                          testId={`edge-invite-done-${invite.nodeId}`}
                          size="sm"
                          onClick={() => dismissLink(invite.joinId)}
                        >
                          {t("views.repositories.inviteDone")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {statusQuery.isError ? (
            <p data-testid="edge-invite-status-error" className="mt-1 ui-micro text-status-blocked">
              {statusQuery.error instanceof Error ? statusQuery.error.message : String(statusQuery.error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
