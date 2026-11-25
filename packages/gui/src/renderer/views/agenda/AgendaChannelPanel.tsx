import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BoundedContent } from "../../components/primitives/BoundedContent.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { TextInput } from "../../components/primitives/TextInput.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { DenseRow } from "../../components/primitives/DenseRow.tsx";
import { FilterChips } from "../../components/primitives/FilterChips.tsx";
import { t } from "../../i18n/index.tsx";
import {
  useChannelListQuery,
  replyPeerRequest,
  promotePeerRequest,
  useInvalidateChannel,
  type ChannelListItem,
} from "../../channel-data.ts";
import { useWorkIndexQuery } from "../../task-data.ts";

const CHANNEL_FILTERS = [
  { key: "all", label: "views.agenda.channelAll" },
  { key: "a2a-peer", label: "views.agenda.channelPeer" },
  { key: "webhook", label: "views.agenda.channelWebhook" },
  { key: "gui", label: "views.agenda.channelGui" },
] as const;

type ChannelFeedback = {
  readonly isError: boolean;
  readonly message: string;
};

export function AgendaChannelPanel({ repoId }: { readonly repoId: string }) {
  const [filter, setFilter] = useState<string>("all");
  const channelKind = filter === "all" ? undefined : filter;
  const channelRead = useChannelListQuery(repoId, channelKind);
  const workRead = useWorkIndexQuery(repoId);
  const invalidate = useInvalidateChannel(repoId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState({ requestId: "", claim: "", action: "" });
  const [feedback, setFeedback] = useState<ChannelFeedback | null>(null);

  const items = channelRead.data?.items ?? [];
  const selected = items.find((item) => item.itemId === selectedId) ?? items[0];
  const replyClaim = replyDraft.requestId === selected?.peerRequestId ? replyDraft.claim : "";
  const replyAction = replyDraft.requestId === selected?.peerRequestId ? replyDraft.action : "";
  const works = workRead.data?.status === "ready" ? workRead.data.works : [];
  const [workId, setWorkId] = useState("");

  const replyMutation = useMutation({
    mutationFn: (payload: { readonly requestId: string; readonly claim: string; readonly requestedAction: string }) =>
      replyPeerRequest({ repoId, ...payload }),
    onMutate: () => setFeedback(null),
    onSuccess: (result, variables) => {
      if (result.outcome === "applied" || result.outcome === "no_changes") {
        setFeedback({ isError: false, message: t("views.agenda.peerReplySent") });
        setReplyDraft({ requestId: variables.requestId, claim: "", action: "" });
        void invalidate();
      } else {
        setFeedback({
          isError: true,
          message: typeof result.hint === "string" ? result.hint : String(result.outcome),
        });
      }
    },
    onError: (cause: unknown) => {
      setFeedback({ isError: true, message: cause instanceof Error ? cause.message : String(cause) });
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (payload: { readonly requestId: string; readonly work: string; readonly title: string }) =>
      promotePeerRequest({ repoId, ...payload }),
    onMutate: () => setFeedback(null),
    onSuccess: (result) => {
      if (result.outcome === "applied" || result.outcome === "no_changes") {
        setFeedback({ isError: false, message: t("views.agenda.peerPromoted") });
        void invalidate();
      } else {
        setFeedback({
          isError: true,
          message: typeof result.hint === "string" ? result.hint : String(result.outcome),
        });
      }
    },
    onError: (cause: unknown) => {
      setFeedback({ isError: true, message: cause instanceof Error ? cause.message : String(cause) });
    },
  });

  const busy = replyMutation.isPending || promoteMutation.isPending;

  const chips = CHANNEL_FILTERS.map(({ key, label }) => ({
    key,
    label: t(label),
    count: key === "all" ? items.length : items.filter((item) => item.channelKind === key).length,
  }));

  const submitReply = () => {
    if (!selected?.peerRequestId || replyDraft.requestId !== selected.peerRequestId || !replyClaim.trim() || busy)
      return;
    replyMutation.mutate({
      requestId: selected.peerRequestId,
      claim: replyClaim.trim(),
      requestedAction: replyAction.trim() || replyClaim.trim(),
    });
  };

  const submitPromote = () => {
    if (!selected?.peerRequestId || !workId || works.every((work) => work.taskId !== workId) || busy) return;
    promoteMutation.mutate({
      requestId: selected.peerRequestId,
      work: workId,
      title: selected.summary,
    });
  };

  return (
    <section className="grid min-w-0 gap-3 border-t border-border pt-3" data-testid="agenda-channel-panel">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="ui-meta font-medium">{t("views.agenda.channelTitle")}</h3>
        <FilterChips chips={chips} value={filter} onChange={setFilter} />
      </header>
      {channelRead.isError && (
        <p role="alert" className="ui-meta text-danger">
          {channelRead.error.message}
        </p>
      )}
      {channelRead.isLoading && <p className="ui-meta text-text-muted">{t("views.agenda.channelLoading")}</p>}
      {items.length === 0 && !channelRead.isLoading && (
        <p className="ui-meta text-text-muted" data-testid="agenda-channel-empty">
          {t("views.agenda.channelEmpty")}
        </p>
      )}
      {items.length > 0 && (
        <div className="grid gap-1">
          {items.map((item: ChannelListItem) => (
            <div key={item.itemId} data-testid={`channel-row-${item.itemId}`}>
              <DenseRow
                relaxed
                selected={selected?.itemId === item.itemId}
                title={item.summary}
                reason={`${item.channelKind} · ${item.direction}`}
                tag={<ChannelStatusTag item={item} />}
                onClick={() => setSelectedId(item.itemId)}
              />
            </div>
          ))}
        </div>
      )}
      {selected?.channelKind === "a2a-peer" && selected.direction === "inbound" && selected.peerRequestId && (
        <div className="grid gap-2 border-t border-border pt-2" data-testid="agenda-peer-actions">
          <BoundedContent className="whitespace-pre-wrap break-words ui-meta">{selected.summary}</BoundedContent>
          <label className="grid gap-1 ui-meta text-text-muted">
            {t("views.agenda.peerPromoteWork")}
            <select
              aria-label={t("views.agenda.peerPromoteWork")}
              value={workId}
              onChange={(event) => setWorkId(event.target.value)}
              disabled={busy || workRead.isLoading}
              className="min-w-0 rounded-xs border border-border bg-surface-raised px-2 py-1.5 text-text"
            >
              <option value="">{t("views.agenda.peerPromoteChooseWork")}</option>
              {works.map((work) => (
                <option key={work.taskId} value={work.taskId}>
                  {work.title}
                </option>
              ))}
            </select>
          </label>
          <TextInput
            testId="agenda-peer-reply-claim"
            label={t("views.agenda.peerReplyClaim")}
            value={replyClaim}
            onChange={(claim) => setReplyDraft({ requestId: selected.peerRequestId!, claim, action: replyAction })}
            disabled={busy}
          />
          <TextInput
            testId="agenda-peer-reply-action"
            label={t("views.agenda.peerReplyAction")}
            value={replyAction}
            onChange={(action) => setReplyDraft({ requestId: selected.peerRequestId!, claim: replyClaim, action })}
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              testId="agenda-peer-reply-submit"
              variant="primary"
              disabled={!replyClaim.trim() || replyDraft.requestId !== selected.peerRequestId || busy}
              loading={replyMutation.isPending}
              onClick={submitReply}
            >
              {t("views.agenda.peerReply")}
            </Button>
            <Button
              testId="agenda-peer-promote-submit"
              disabled={!workId || works.every((work) => work.taskId !== workId) || busy}
              loading={promoteMutation.isPending}
              onClick={submitPromote}
            >
              {t("views.agenda.peerPromote")}
            </Button>
          </div>
        </div>
      )}
      {feedback && (
        <p
          role={feedback.isError ? "alert" : "status"}
          data-testid="agenda-channel-feedback"
          data-state={feedback.isError ? "error" : "success"}
          className={feedback.isError ? "break-words ui-meta text-danger" : "break-words ui-meta"}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function ChannelStatusTag({ item }: { readonly item: ChannelListItem }) {
  const tone =
    item.status === "delivered" || item.status === "routed"
      ? "done"
      : item.status === "duplicate"
        ? "neutral"
        : item.status === "failed"
          ? "bad"
          : "wait";
  return <StatusTag tone={tone} label={item.channelKind} />;
}
