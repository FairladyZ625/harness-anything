import { useState } from "react";
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
import { consumeKnownError } from "../../../api/error-consumption.ts";

const CHANNEL_FILTERS = [
  { key: "all", label: "views.agenda.channelAll" },
  { key: "a2a-peer", label: "views.agenda.channelPeer" },
  { key: "webhook", label: "views.agenda.channelWebhook" },
  { key: "gui", label: "views.agenda.channelGui" },
] as const;

export function AgendaChannelPanel({ repoId }: { readonly repoId: string }) {
  const [filter, setFilter] = useState<string>("all");
  const channelKind = filter === "all" ? undefined : filter;
  const channelRead = useChannelListQuery(repoId, channelKind);
  const invalidate = useInvalidateChannel(repoId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyClaim, setReplyClaim] = useState("");
  const [replyAction, setReplyAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const items = channelRead.data?.items ?? [];
  const selected = items.find((item) => item.itemId === selectedId) ?? items[0];

  const chips = CHANNEL_FILTERS.map(({ key, label }) => ({
    key,
    label: t(label),
    count: key === "all" ? items.length : items.filter((item) => item.channelKind === key).length,
  }));

  const submitReply = async () => {
    if (!selected?.peerRequestId || !replyClaim.trim()) return;
    setBusy(true);
    try {
      const result = await replyPeerRequest({
        repoId,
        requestId: selected.peerRequestId,
        claim: replyClaim.trim(),
        requestedAction: replyAction.trim() || replyClaim.trim(),
      });
      if (result.outcome === "applied" || result.outcome === "no_changes") {
        setFeedback(t("views.agenda.peerReplySent"));
        setReplyClaim("");
        setReplyAction("");
        invalidate();
      } else {
        setFeedback(typeof result.hint === "string" ? result.hint : String(result.outcome));
      }
    } catch (cause) {
      consumeKnownError(cause);
      setFeedback(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitPromote = async () => {
    if (!selected?.peerRequestId) return;
    setBusy(true);
    try {
      const result = await promotePeerRequest({
        repoId,
        requestId: selected.peerRequestId,
        work: "work_default",
        title: selected.summary,
      });
      if (result.outcome === "applied" || result.outcome === "no_changes") {
        setFeedback(t("views.agenda.peerPromoted"));
        invalidate();
      } else {
        setFeedback(typeof result.hint === "string" ? result.hint : String(result.outcome));
      }
    } catch (cause) {
      consumeKnownError(cause);
      setFeedback(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
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
      {selected?.channelKind === "a2a-peer" && selected.peerRequestId && (
        <div className="grid gap-2 border-t border-border pt-2" data-testid="agenda-peer-actions">
          <BoundedContent className="whitespace-pre-wrap break-words ui-meta">{selected.summary}</BoundedContent>
          <TextInput
            testId="agenda-peer-reply-claim"
            label={t("views.agenda.peerReplyClaim")}
            value={replyClaim}
            onChange={setReplyClaim}
            disabled={busy}
          />
          <TextInput
            testId="agenda-peer-reply-action"
            label={t("views.agenda.peerReplyAction")}
            value={replyAction}
            onChange={setReplyAction}
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              testId="agenda-peer-reply-submit"
              variant="primary"
              disabled={!replyClaim.trim() || busy}
              loading={busy}
              onClick={() => void submitReply()}
            >
              {t("views.agenda.peerReply")}
            </Button>
            <Button testId="agenda-peer-promote-submit" disabled={busy} loading={busy} onClick={() => void submitPromote()}>
              {t("views.agenda.peerPromote")}
            </Button>
          </div>
        </div>
      )}
      {feedback && (
        <p role="status" className="break-words ui-meta">
          {feedback}
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