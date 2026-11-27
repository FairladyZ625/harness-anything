import { useState } from "react";
import type { ResidentCeoHistoryEntryRead, ResidentCeoWakeCause } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { formatListTime, formatTime } from "../../model/time.ts";
import { EntityRefLink, entityRefOf } from "../../components/EntityRefLink.tsx";
import { MarkdownDocument } from "../../components/MarkdownDocument.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { Empty } from "../../components/primitives/Empty.tsx";
import { KV, KVRow } from "../../components/primitives/Fields.tsx";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag.tsx";

type TimelineFilter = "all" | ResidentCeoWakeCause;

function wakeStatusTone(status: ResidentCeoHistoryEntryRead["status"]): StatusTone {
  switch (status) {
    case "running":
      return "active";
    case "succeeded":
      return "done";
    case "failed":
      return "bad";
  }
}

function causeLabel(cause: ResidentCeoWakeCause): string {
  switch (cause) {
    case "human-chat":
      return t("residentCeo.cause.humanChat");
    case "peer-request":
      return t("residentCeo.cause.peerRequest");
    case "heartbeat":
      return t("residentCeo.cause.heartbeat");
  }
}

function ExecutionDetails({
  entry,
  onNavigateEntity,
}: {
  readonly entry: ResidentCeoHistoryEntryRead;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const exec = entry.execution;
  const tokenSummary =
    exec?.totalTokens !== undefined
      ? `${exec.totalTokens} (in ${exec.inputTokens ?? 0} / out ${exec.outputTokens ?? 0})`
      : null;

  return (
    <div
      data-testid={`resident-ceo-entry-details-${entry.wakeId}`}
      className="mt-2 rounded border border-border bg-surface px-3 py-2"
    >
      <KV>
        <KVRow name={t("residentCeo.detail.wakeId")}>
          <span className="font-mono">{entry.wakeId}</span>
        </KVRow>
        {entry.runtimeSessionId ? (
          <KVRow name={t("residentCeo.detail.session")}>
            <EntityRefLink entityRef={entityRefOf("session", entry.runtimeSessionId)} onNavigate={onNavigateEntity}>
              {entry.runtimeSessionId}
            </EntityRefLink>
          </KVRow>
        ) : null}
        {exec?.runtimeInstanceId || exec?.model ? (
          <KVRow name={t("residentCeo.detail.model")}>
            <span className="font-mono">{[exec.runtimeInstanceId, exec.model].filter(Boolean).join(" · ")}</span>
          </KVRow>
        ) : null}
        {exec?.permissionMode ? (
          <KVRow name={t("residentCeo.detail.permission")}>
            <span className="font-mono">{exec.permissionMode}</span>
          </KVRow>
        ) : null}
        {exec?.toolCallCount !== undefined ? (
          <KVRow name={t("residentCeo.detail.tools")}>
            <span className="font-mono tabular-nums">{exec.toolCallCount}</span>
          </KVRow>
        ) : null}
        {tokenSummary ? (
          <KVRow name={t("residentCeo.detail.tokens")}>
            <span className="font-mono tabular-nums">{tokenSummary}</span>
          </KVRow>
        ) : null}
        {entry.completedAt ? (
          <KVRow name={t("residentCeo.detail.completedAt")}>
            {formatTime(entry.completedAt, { style: "date-time-seconds" }) ?? entry.completedAt}
          </KVRow>
        ) : null}
        {entry.detail ? <KVRow name={t("residentCeo.detail.diagnostic")}>{entry.detail}</KVRow> : null}
      </KV>
    </div>
  );
}

export function ResidentCeoTimeline({
  entries,
  configured,
  onNavigateEntity,
}: {
  readonly entries: readonly ResidentCeoHistoryEntryRead[];
  readonly configured: boolean;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [expandedDetails, setExpandedDetails] = useState<Readonly<Record<string, boolean>>>(() => ({}));
  const [expandedHeartbeats, setExpandedHeartbeats] = useState<Readonly<Record<string, boolean>>>(() => ({}));

  const counts = {
    all: entries.length,
    "human-chat": entries.filter((item) => item.cause === "human-chat").length,
    "peer-request": entries.filter((item) => item.cause === "peer-request").length,
    heartbeat: entries.filter((item) => item.cause === "heartbeat").length,
  };

  const visible = filter === "all" ? entries : entries.filter((item) => item.cause === filter);

  const toggleDetail = (wakeId: string) => {
    setExpandedDetails((prev) => ({ ...prev, [wakeId]: !prev[wakeId] }));
  };

  const toggleHeartbeat = (wakeId: string) => {
    setExpandedHeartbeats((prev) => ({ ...prev, [wakeId]: !prev[wakeId] }));
  };

  const filterButtons: readonly { readonly id: TimelineFilter; readonly label: string; readonly count: number }[] = [
    { id: "all", label: t("residentCeo.filter.all"), count: counts.all },
    { id: "human-chat", label: t("residentCeo.filter.humanChat"), count: counts["human-chat"] },
    { id: "peer-request", label: t("residentCeo.filter.peerRequest"), count: counts["peer-request"] },
    { id: "heartbeat", label: t("residentCeo.filter.heartbeat"), count: counts.heartbeat },
  ];

  return (
    <div data-testid="resident-ceo-timeline-region" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-5 py-2">
        <span className="mr-1 ui-micro font-semibold text-text-faint">{t("residentCeo.conversation")}</span>
        {filterButtons.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={filter === item.id ? "primary" : "ghost"}
            testId={`resident-ceo-filter-${item.id}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            <span className="font-mono tabular-nums opacity-75">{item.count}</span>
          </Button>
        ))}
      </div>

      <div data-testid="resident-ceo-timeline" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {visible.length === 0 ? (
          <Empty>{configured ? t("residentCeo.emptyHistory") : t("residentCeo.notConfiguredHint")}</Empty>
        ) : (
          visible.map((entry) => {
            const timeLabel = formatListTime(entry.requestedAt);
            const fullTime = formatTime(entry.requestedAt, { style: "date-time-seconds" }) ?? entry.requestedAt;

            if (entry.cause === "heartbeat") {
              const isOpen = Boolean(expandedHeartbeats[entry.wakeId]);
              const compactNote = entry.detail ?? entry.responseText ?? entry.requestText ?? "";
              return (
                <article
                  key={entry.wakeId}
                  data-testid={`resident-ceo-heartbeat-${entry.wakeId}`}
                  data-entry-cause="heartbeat"
                  className="rounded border border-border/80 bg-surface/60 px-3 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-2 ui-micro text-text-faint">
                    <StatusTag tone="neutral" label={causeLabel("heartbeat")} />
                    <StatusTag
                      tone={wakeStatusTone(entry.status)}
                      label={t(`residentCeo.wakeStatus.${entry.status}`)}
                    />
                    <span className="min-w-0 flex-1 truncate text-text-muted">{compactNote}</span>
                    <span className="font-mono" title={fullTime}>
                      {timeLabel}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      testId={`resident-ceo-heartbeat-toggle-${entry.wakeId}`}
                      onClick={() => toggleHeartbeat(entry.wakeId)}
                    >
                      {isOpen ? t("residentCeo.collapseHeartbeat") : t("residentCeo.expandHeartbeat")}
                    </Button>
                  </div>
                  {isOpen ? (
                    <div className="mt-2 space-y-2 border-t border-border/70 pt-2">
                      {entry.responseText ? (
                        <div className="prose-harness break-words ui-meta text-text" data-layout="single">
                          <MarkdownDocument content={entry.responseText} />
                        </div>
                      ) : null}
                      <ExecutionDetails entry={entry} onNavigateEntity={onNavigateEntity} />
                    </div>
                  ) : null}
                </article>
              );
            }

            const detailsOpen = Boolean(expandedDetails[entry.wakeId]);
            const isPeer = entry.cause === "peer-request";

            return (
              <article
                key={entry.wakeId}
                data-testid={`resident-ceo-entry-${entry.wakeId}`}
                data-entry-cause={entry.cause}
                className="flex flex-col gap-2"
              >
                {isPeer ? (
                  <div className="rounded-md border border-border-strong bg-surface px-3.5 py-2.5">
                    <div className="flex flex-wrap items-center gap-2 ui-micro">
                      <StatusTag tone="wait" label={causeLabel("peer-request")} />
                      {entry.fromPersonId ? (
                        <span className="font-mono text-text">
                          {t("residentCeo.peerFrom")}: {entry.fromPersonId}
                        </span>
                      ) : null}
                      {entry.peerRequestId ? (
                        <span className="font-mono text-text-faint">{entry.peerRequestId}</span>
                      ) : null}
                      <span className="ml-auto font-mono text-text-faint" title={fullTime}>
                        {timeLabel}
                      </span>
                    </div>
                    {entry.peerSummary ? (
                      <p className="mt-1 ui-body font-medium text-text">{entry.peerSummary}</p>
                    ) : null}
                    {entry.requestText && entry.requestText !== entry.peerSummary ? (
                      <p className="mt-1 whitespace-pre-wrap break-words ui-meta text-text-muted">
                        {entry.requestText}
                      </p>
                    ) : null}
                  </div>
                ) : entry.requestText ? (
                  <div className="ml-auto max-w-[82%] rounded-md border border-accent/35 bg-accent/10 px-3.5 py-2">
                    <div className="mb-1 flex items-center justify-between gap-3 ui-micro text-text-faint">
                      <span className="font-semibold text-text">{t("residentCeo.ownerLabel")}</span>
                      <span className="font-mono" title={fullTime}>
                        {timeLabel}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words ui-body text-text">{entry.requestText}</p>
                  </div>
                ) : null}

                <div className="max-w-[90%] rounded-md border border-border bg-surface-raised px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 ui-micro">
                    <span className="font-semibold text-text">{t("residentCeo.ceoLabel")}</span>
                    <StatusTag
                      tone={wakeStatusTone(entry.status)}
                      label={t(`residentCeo.wakeStatus.${entry.status}`)}
                    />
                    {entry.proposalId ? (
                      <StatusTag tone="wait" label={`${t("residentCeo.linkedProposal")}: ${entry.proposalId}`} mono />
                    ) : null}
                    {entry.execution?.toolCallCount ? (
                      <span className="font-mono text-text-faint">
                        {t("residentCeo.detail.tools")}: {entry.execution.toolCallCount}
                      </span>
                    ) : null}
                    <div className="ml-auto">
                      <Button
                        size="sm"
                        variant="ghost"
                        testId={`resident-ceo-entry-details-toggle-${entry.wakeId}`}
                        onClick={() => toggleDetail(entry.wakeId)}
                      >
                        {detailsOpen ? t("residentCeo.hideDetails") : t("residentCeo.showDetails")}
                      </Button>
                    </div>
                  </div>
                  {entry.responseText ? (
                    <div
                      data-testid={`resident-ceo-entry-response-${entry.wakeId}`}
                      className="prose-harness mt-2 break-words ui-body text-text"
                      data-layout="single"
                    >
                      <MarkdownDocument content={entry.responseText} />
                    </div>
                  ) : entry.detail ? (
                    <p className="mt-2 whitespace-pre-wrap break-words ui-meta text-danger">{entry.detail}</p>
                  ) : null}
                  {detailsOpen ? <ExecutionDetails entry={entry} onNavigateEntity={onNavigateEntity} /> : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
