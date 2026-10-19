import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "../../i18n/index.tsx";
import { QUERY_PACING_MS } from "../../query-pacing.ts";
import { fetchEdgeJoinGroups, fetchEdgeJoinList, issueEdgeJoin, revokeEdgeJoin } from "../../edge-invite-client.ts";
import type { EdgeJoinIssued } from "../../../api/access-admin-contract.ts";
import { CopyContextButton } from "../../components/CopyContextButton.tsx";
import { Row } from "../../components/ui/widgets.tsx";
import { Section } from "../../components/primitives/Section.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { formatTime } from "../../model/time.ts";

const INPUT_CLASS = [
  "w-72 max-w-full rounded border border-border bg-surface-raised px-2 py-1",
  "font-mono ui-meta text-text",
].join(" ");
const statusTone = { pending: "wait", consumed: "done", expired: "bad", revoked: "bad" } as const;

export function EdgeInvitePanel({ repos }: { readonly repos: readonly { readonly repoId: string }[] }) {
  const queryClient = useQueryClient(),
    [personId, setPersonId] = useState(""),
    [username, setUsername] = useState(""),
    [email, setEmail] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [nodeLabel, setNodeLabel] = useState(""),
    [selectedRepoIds, setSelectedRepoIds] = useState<readonly string[]>([]),
    [selectedGroupIds, setSelectedGroupIds] = useState<readonly string[]>([]),
    [issued, setIssued] = useState<EdgeJoinIssued | null>(null),
    [feedback, setFeedback] = useState<string | null>(null);
  const groupQuery = useQuery({ queryKey: ["edge-join", "groups"], queryFn: fetchEdgeJoinGroups }),
    joinsQuery = useQuery({
      queryKey: ["edge-join", "list"],
      queryFn: fetchEdgeJoinList,
      refetchInterval: (query) =>
        query.state.data?.some((row) => row.state === "pending") ? QUERY_PACING_MS.edgeJoinStatus : false,
    });
  const issue = useMutation({
      mutationFn: issueEdgeJoin,
      onSuccess: async (result) => {
        setIssued(result);
        setPersonId("");
        setUsername("");
        setEmail("");
        setDisplayName("");
        setNodeLabel("");
        await queryClient.invalidateQueries({ queryKey: ["edge-join", "list"] });
      },
    }),
    revoke = useMutation({
      mutationFn: revokeEdgeJoin,
      onSuccess: async () => await queryClient.invalidateQueries({ queryKey: ["edge-join", "list"] }),
    });
  const groups = groupQuery.data?.groups ?? [];
  const submit = () => {
    setFeedback(null);
    if (
      !personId.trim() ||
      !username.trim() ||
      !email.trim() ||
      !displayName.trim() ||
      selectedRepoIds.length === 0 ||
      selectedGroupIds.length === 0
    ) {
      setFeedback(t("views.repositories.inviteFieldsRequired"));
      return;
    }
    issue.mutate({
      personId: personId.trim(),
      username: username.trim(),
      email: email.trim(),
      displayName: displayName.trim(),
      repoIds: selectedRepoIds,
      groupIds: selectedGroupIds,
      ...(nodeLabel.trim() ? { nodeLabel: nodeLabel.trim() } : {}),
    });
  };

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
      <div className="flex flex-col gap-2">
        <Row label={t("views.repositories.invitePersonIdLabel")}>
          <input
            data-testid="edge-invite-person-id"
            aria-label={t("views.repositories.invitePersonIdLabel")}
            className={INPUT_CLASS}
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
          />
        </Row>
        <Row label={t("views.repositories.inviteUsernameLabel")}>
          <input
            data-testid="edge-invite-username"
            className={INPUT_CLASS}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Row>
        <Row label={t("views.repositories.inviteEmailLabel")}>
          <input
            data-testid="edge-invite-email"
            className={INPUT_CLASS}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Row>
        <Row label={t("views.repositories.inviteDisplayNameLabel")}>
          <input
            data-testid="edge-invite-display-name"
            className={INPUT_CLASS}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Row>
        <Row label={t("views.repositories.inviteNodeLabelLabel")}>
          <input
            data-testid="edge-invite-node-label"
            className={INPUT_CLASS}
            value={nodeLabel}
            onChange={(event) => setNodeLabel(event.target.value)}
          />
        </Row>
        <fieldset className="flex flex-col gap-1 rounded border border-border px-3 py-2">
          <legend className="px-1 font-mono ui-meta text-text-muted">{t("views.repositories.inviteReposLabel")}</legend>
          {repos.length === 0 ? (
            <p className="ui-meta text-text-faint">{t("views.repositories.inviteNoRepos")}</p>
          ) : (
            repos.map((repo) => (
              <label key={repo.repoId} className="flex items-center gap-2 ui-meta text-text">
                <input
                  data-testid={`edge-invite-repo-${repo.repoId}`}
                  type="checkbox"
                  checked={selectedRepoIds.includes(repo.repoId)}
                  onChange={(event) =>
                    setSelectedRepoIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, repo.repoId])]
                        : current.filter((repoId) => repoId !== repo.repoId),
                    )
                  }
                />
                <span className="font-mono">{repo.repoId}</span>
              </label>
            ))
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-1 rounded border border-border px-3 py-2">
          <legend className="px-1 font-mono ui-meta text-text-muted">
            {t("views.repositories.inviteGroupsLabel")}
          </legend>
          {groups.map((group) => (
            <label key={group.id} className="flex items-center gap-2 ui-meta text-text">
              <input
                data-testid={`edge-invite-group-${group.id}`}
                type="checkbox"
                checked={selectedGroupIds.includes(group.id)}
                onChange={(event) =>
                  setSelectedGroupIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, group.id])]
                      : current.filter((groupId) => groupId !== group.id),
                  )
                }
              />
              <span>{group.displayName}</span>
              <span className="font-mono text-text-faint">{group.id}</span>
            </label>
          ))}
          {groupQuery.isLoading ? (
            <p className="ui-meta text-text-faint">{t("views.repositories.inviteLoadingGroups")}</p>
          ) : null}
          {groupQuery.isError ? (
            <p role="alert" className="ui-meta text-status-blocked">
              {String(groupQuery.error)}
            </p>
          ) : null}
        </fieldset>
      </div>

      {feedback ? (
        <p role="alert" className="mt-2 ui-meta text-status-blocked">
          {feedback}
        </p>
      ) : null}
      {issue.isError ? (
        <p role="alert" className="mt-2 ui-meta text-status-blocked">
          {String(issue.error)}
        </p>
      ) : null}
      {issued ? (
        <div className="mt-3 rounded border border-border bg-surface-raised p-3" data-testid="edge-invite-issued">
          <p className="ui-meta text-text-muted">{t("views.repositories.inviteLinkHint")}</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono ui-micro text-text">
            {issued.inviteLink}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <CopyContextButton
              label={t("views.repositories.inviteCopyAction")}
              title={t("views.repositories.inviteCopyTitle")}
              buildText={() => issued.inviteLink}
              testId="edge-invite-copy"
            />
            <Button testId="edge-invite-done" onClick={() => setIssued(null)}>
              {t("views.repositories.inviteDone")}
            </Button>
            <span className="ui-micro text-text-faint">
              {t("views.repositories.inviteExpires")}
              {formatTime(issued.expiresAt, { style: "date-time" })}
            </span>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-2" data-testid="edge-invite-list">
        <h3 className="font-mono ui-meta uppercase tracking-wide text-text-faint">
          {t("views.repositories.inviteAuditTitle")}
        </h3>
        {joinsQuery.data?.map((join) => (
          <div key={join.joinId} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5">
            <StatusTag
              tone={statusTone[join.state]}
              label={t(`views.repositories.inviteStatus.${join.state}` as never)}
            />
            <span className="font-mono ui-micro text-text">{join.personId}</span>
            <span className="font-mono ui-micro text-text-faint">{join.repoIds.join(", ")}</span>
            <span className="font-mono ui-micro text-text-faint">{join.groupIds.join(", ")}</span>
            {join.nodeId ? <span className="font-mono ui-micro text-text-faint">{join.nodeId}</span> : null}
            <span className="ui-micro text-text-faint">{formatTime(join.expiresAt, { style: "date-time" })}</span>
            {join.state === "pending" ? (
              <Button
                testId={`edge-invite-revoke-${join.joinId}`}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(join.joinId)}
              >
                {t("views.repositories.inviteRevoke")}
              </Button>
            ) : null}
          </div>
        ))}
        {joinsQuery.isError ? (
          <p role="alert" className="ui-meta text-status-blocked">
            {String(joinsQuery.error)}
          </p>
        ) : null}
        {revoke.isError ? (
          <p role="alert" className="ui-meta text-status-blocked">
            {String(revoke.error)}
          </p>
        ) : null}
      </div>
    </Section>
  );
}
