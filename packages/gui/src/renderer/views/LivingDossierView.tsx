import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsClockwise, Sparkle } from "@phosphor-icons/react";
import type { DossierStatusRead } from "../../api/renderer-dto.ts";
import { DocReader } from "../components/DocReader.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { CatalogBackButton, CatalogSplit, catalogRailClass } from "../components/primitives/CatalogSplit.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { Notice } from "../components/primitives/Notice.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { dossierClient, dossierQueryKeys, refreshDossierSlot } from "../dossier-client.ts";
import { t } from "../i18n/index.tsx";
import { formatListTime, formatTime } from "../model/time.ts";

type SlotKindFilter = "all" | "html" | "markdown";
type DossierStatusSlot = DossierStatusRead["slots"][number];

interface FeedbackBanner {
  readonly tone: "bad" | "wait" | "neutral";
  readonly text: string;
}

function slotFreshnessMeta(slot: DossierStatusSlot): { readonly tone: StatusTone; readonly label: string } {
  if (slot.synthesizedAt === null) {
    return { tone: "plan", label: t("dossier.state.unsynthesized") };
  }
  if (slot.stalenessDelta > 0) {
    return { tone: "wait", label: t("dossier.state.staleDelta", { delta: slot.stalenessDelta }) };
  }
  return { tone: "done", label: t("dossier.state.fresh") };
}

function triggerBadgeText(slot: DossierStatusSlot): string | null {
  if (slot.dueTriggers.length === 0) return null;
  return slot.dueTriggers
    .map((trigger) =>
      trigger.kind === "event-watermark"
        ? t("dossier.trigger.watermark", { delta: trigger.minimumDelta })
        : t("dossier.trigger.periodic"),
    )
    .join(" · ");
}

export function LivingDossierView({ repoId }: { readonly repoId: string }) {
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<SlotKindFilter>("all");
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackBanner | null>(null);

  const statusQuery = useQuery({
    queryKey: dossierQueryKeys.status(repoId),
    queryFn: () => dossierClient.status(repoId),
    enabled: repoId !== "unselected",
    staleTime: 10_000,
  });

  const allSlots = useMemo(() => statusQuery.data?.slots ?? [], [statusQuery.data?.slots]);
  const filteredSlots = useMemo(() => {
    if (kindFilter === "all") return allSlots;
    return allSlots.filter((slot) => slot.kind === kindFilter);
  }, [allSlots, kindFilter]);

  const activeSlot = useMemo(() => {
    if (filteredSlots.length === 0) return null;
    if (selectedSlotId !== null) {
      const matched = filteredSlots.find((slot) => slot.id === selectedSlotId);
      if (matched) return matched;
    }
    return filteredSlots[0]!;
  }, [filteredSlots, selectedSlotId]);

  const contentQuery = useQuery({
    queryKey: dossierQueryKeys.read(repoId, activeSlot?.id ?? ""),
    queryFn: () => dossierClient.read(repoId, activeSlot!.id),
    enabled: repoId !== "unselected" && activeSlot !== null,
    staleTime: 10_000,
  });

  const staleSlots = useMemo(
    () => allSlots.filter((slot) => slot.synthesizedAt === null || slot.stalenessDelta > 0),
    [allSlots],
  );
  const htmlCount = useMemo(() => allSlots.filter((slot) => slot.kind === "html").length, [allSlots]);
  const markdownCount = useMemo(() => allSlots.filter((slot) => slot.kind === "markdown").length, [allSlots]);

  const reloadDossierQueries = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: dossierQueryKeys.all(repoId) });
  }, [queryClient, repoId]);

  const slotRefreshMutation = useMutation({
    mutationFn: async (input: { readonly verticalId: string; readonly slot: DossierStatusSlot }) => {
      const outcome = await refreshDossierSlot({
        repoId,
        verticalId: input.verticalId,
        slot: input.slot,
      });
      await reloadDossierQueries();
      return { slot: input.slot, outcome };
    },
    onSuccess: ({ slot, outcome }) => {
      if (!outcome.ok) {
        setFeedback({
          tone: outcome.conflict ? "wait" : "bad",
          text: outcome.conflict
            ? t("dossier.feedback.conflict", { slot: slot.title, error: outcome.message })
            : t("dossier.feedback.failed", { slot: slot.title, error: outcome.message }),
        });
        return;
      }
      setFeedback(
        outcome.remaining
          ? {
              tone: "wait",
              text: t("dossier.feedback.partial", {
                slot: slot.title,
                pages: outcome.pagesApplied,
                watermark: outcome.reachedWatermark,
              }),
            }
          : {
              tone: "neutral",
              text: t("dossier.feedback.updated", {
                slot: slot.title,
                watermark: outcome.reachedWatermark,
              }),
            },
      );
    },
    onError: (error, { slot }) => {
      setFeedback({
        tone: "bad",
        text: t("dossier.feedback.failed", {
          slot: slot.title,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    },
  });

  const batchRefreshMutation = useMutation({
    mutationFn: async (input: { readonly verticalId: string; readonly slots: readonly DossierStatusSlot[] }) => {
      let updatedCount = 0;
      let remainingCount = 0;
      for (const slot of input.slots) {
        const outcome = await refreshDossierSlot({
          repoId,
          verticalId: input.verticalId,
          slot,
        });
        if (!outcome.ok) {
          await reloadDossierQueries();
          return { failed: { slot, outcome }, updatedCount, remainingCount } as const;
        }
        updatedCount += 1;
        if (outcome.remaining) remainingCount += 1;
      }
      await reloadDossierQueries();
      return { failed: null, updatedCount, remainingCount } as const;
    },
    onSuccess: ({ failed, updatedCount, remainingCount }) => {
      if (failed) {
        setFeedback({
          tone: failed.outcome.conflict ? "wait" : "bad",
          text: failed.outcome.conflict
            ? t("dossier.feedback.conflict", { slot: failed.slot.title, error: failed.outcome.message })
            : t("dossier.feedback.failed", { slot: failed.slot.title, error: failed.outcome.message }),
        });
        return;
      }
      setFeedback({
        tone: remainingCount > 0 ? "wait" : "neutral",
        text:
          remainingCount > 0
            ? t("dossier.feedback.batchPartial", { updated: updatedCount, remaining: remainingCount })
            : t("dossier.feedback.batchDone", { updated: updatedCount }),
      });
    },
    onError: (error) => {
      void reloadDossierQueries();
      setFeedback({
        tone: "bad",
        text: t("dossier.feedback.batchFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    },
  });

  const busyMode: "idle" | "slot" | "all" = slotRefreshMutation.isPending
    ? "slot"
    : batchRefreshMutation.isPending
      ? "all"
      : "idle";

  const handleRefreshSlot = useCallback(
    (slot: DossierStatusSlot) => {
      const status = statusQuery.data;
      if (!status || busyMode !== "idle") return;
      setFeedback(null);
      slotRefreshMutation.mutate({ verticalId: status.verticalId, slot });
    },
    [busyMode, slotRefreshMutation, statusQuery.data],
  );

  const handleRefreshAllStale = useCallback(() => {
    const status = statusQuery.data;
    if (!status || staleSlots.length === 0 || busyMode !== "idle") return;
    setFeedback(null);
    batchRefreshMutation.mutate({ verticalId: status.verticalId, slots: staleSlots });
  }, [batchRefreshMutation, busyMode, staleSlots, statusQuery.data]);

  const currentWatermark = statusQuery.data?.currentWatermark ?? 0;

  return (
    <section data-testid="living-dossier-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="dossier-header"
        title={t("dossier.title")}
        meta={
          statusQuery.data ? (
            <span data-testid="dossier-header-meta">
              {statusQuery.data.verticalId} · r{currentWatermark} ·{" "}
              {t("dossier.counts", { total: allSlots.length, stale: staleSlots.length })}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              testId="dossier-reload"
              ariaLabel={t("dossier.action.reload")}
              disabled={busyMode !== "idle" || statusQuery.isFetching}
              onClick={() => void reloadDossierQueries()}
            >
              <ArrowsClockwise className="size-3.5" />
            </Button>
            <Button
              variant="primary"
              size="sm"
              testId="dossier-refresh-all"
              loading={busyMode === "all"}
              disabled={busyMode !== "idle" || staleSlots.length === 0}
              onClick={() => void handleRefreshAllStale()}
            >
              <Sparkle className="size-3.5" />
              {staleSlots.length > 0
                ? t("dossier.action.refreshAllCount", { count: staleSlots.length })
                : t("dossier.action.allFresh")}
            </Button>
          </>
        }
      />
      {statusQuery.isError && (
        <Notice tone="bad" variant="strip" testId="dossier-status-error">
          {t("dossier.error.statusFailed", {
            error: statusQuery.error instanceof Error ? statusQuery.error.message : String(statusQuery.error),
          })}
        </Notice>
      )}
      {feedback && (
        <Notice tone={feedback.tone} variant="strip" testId="dossier-feedback">
          {feedback.text}
        </Notice>
      )}
      <CatalogSplit detailOpen={selectedSlotId !== null} className="overflow-hidden border-t border-border">
        <aside data-testid="dossier-slot-list" className={catalogRailClass}>
          <div className="border-b border-border px-3 py-2" data-testid="dossier-filters">
            <FilterChips
              value={kindFilter}
              onChange={setKindFilter}
              chips={[
                { key: "all", label: t("dossier.filter.all"), count: allSlots.length },
                { key: "html", label: t("dossier.filter.html"), count: htmlCount },
                { key: "markdown", label: t("dossier.filter.markdown"), count: markdownCount },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {statusQuery.isPending ? (
              <Empty>{t("dossier.loading")}</Empty>
            ) : filteredSlots.length === 0 ? (
              <Empty>{t("dossier.emptySlots")}</Empty>
            ) : (
              <ul className="flex flex-col">
                {filteredSlots.map((slot) => {
                  const freshness = slotFreshnessMeta(slot);
                  const triggerText = triggerBadgeText(slot);
                  return (
                    <li key={slot.id} data-testid={`dossier-slot-row-${slot.id}`}>
                      <DenseRow
                        relaxed
                        selected={activeSlot?.id === slot.id}
                        onClick={() => setSelectedSlotId(slot.id)}
                        tag={
                          <StatusTag
                            tone={slot.kind === "html" ? "active" : "neutral"}
                            mono
                            label={slot.kind === "html" ? "HTML" : "MD"}
                          />
                        }
                        title={slot.title}
                        reason={
                          <span className="font-mono ui-micro text-text-muted">
                            {slot.path} · r{slot.lastSynthesizedWatermark}/r{currentWatermark}
                            {triggerText ? ` · ${triggerText}` : ""}
                          </span>
                        }
                        time={<StatusTag tone={freshness.tone} mono label={freshness.label} />}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
        <div data-testid="dossier-reader-pane" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg">
          {activeSlot === null ? (
            <Empty>{t("dossier.emptySlots")}</Empty>
          ) : (
            <DossierSlotPane
              slot={activeSlot}
              currentWatermark={currentWatermark}
              contentQuery={contentQuery}
              busy={busyMode !== "idle"}
              refreshingSlot={busyMode === "slot"}
              onBack={() => setSelectedSlotId(null)}
              onRefresh={() => void handleRefreshSlot(activeSlot)}
            />
          )}
        </div>
      </CatalogSplit>
    </section>
  );
}

function DossierSlotPane({
  slot,
  currentWatermark,
  contentQuery,
  busy,
  refreshingSlot,
  onBack,
  onRefresh,
}: {
  readonly slot: DossierStatusSlot;
  readonly currentWatermark: number;
  readonly contentQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof dossierClient.read>>>>;
  readonly busy: boolean;
  readonly refreshingSlot: boolean;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
}) {
  const freshness = slotFreshnessMeta(slot);
  const triggerText = triggerBadgeText(slot);
  const body = contentQuery.data?.body ?? null;
  const needsUpdate = body === null || slot.stalenessDelta > 0;
  const canRefresh = currentWatermark > slot.lastSynthesizedWatermark;

  return (
    <>
      <header
        data-testid="dossier-slot-toolbar"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2"
      >
        <div className="min-w-0 flex-1">
          <CatalogBackButton testId="dossier-back-to-list" onBack={onBack} />
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text" data-testid="dossier-active-title">
              {slot.title}
            </h2>
            <StatusTag tone={freshness.tone} mono label={freshness.label} testId="dossier-active-freshness" />
            {triggerText && <StatusTag tone="wait" mono label={triggerText} testId="dossier-active-triggers" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono ui-micro text-text-faint">
            <span data-testid="dossier-active-path">{slot.documentPath}</span>
            <span>·</span>
            <span data-testid="dossier-active-watermark">
              r{slot.lastSynthesizedWatermark} / r{currentWatermark}
            </span>
            {slot.synthesizedAt && (
              <>
                <span>·</span>
                <span title={formatTime(slot.synthesizedAt, { style: "date-time-seconds" }) ?? slot.synthesizedAt}>
                  {formatListTime(slot.synthesizedAt)}
                </span>
              </>
            )}
          </div>
        </div>
        <Button
          variant={needsUpdate ? "primary" : "plain"}
          size="sm"
          testId="dossier-refresh-slot"
          loading={refreshingSlot}
          disabled={busy || !canRefresh}
          onClick={onRefresh}
        >
          <ArrowsClockwise className="size-3.5" />
          {body === null ? t("dossier.action.generateFirst") : t("dossier.action.refreshSlot")}
        </Button>
      </header>
      <div
        data-testid="dossier-slot-content"
        className={`flex min-h-0 flex-1 flex-col ${slot.kind === "html" ? "overflow-hidden" : "overflow-y-auto p-3"}`}
      >
        {contentQuery.isPending ? (
          <Empty>{t("dossier.loadingContent")}</Empty>
        ) : contentQuery.isError ? (
          <Notice tone="bad" testId="dossier-read-error">
            {t("dossier.error.readFailed", {
              error: contentQuery.error instanceof Error ? contentQuery.error.message : String(contentQuery.error),
            })}
          </Notice>
        ) : body === null ? (
          <div
            data-testid="dossier-unsynthesized"
            className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
          >
            <div className="flex flex-wrap justify-center gap-1.5">
              {slot.entityKinds.map((kind) => (
                <StatusTag key={kind} tone="neutral" mono label={kind} />
              ))}
            </div>
            <p className="font-mono ui-meta text-text-muted">
              {slot.path} · r0 / r{currentWatermark}
            </p>
            <Button
              variant="primary"
              testId="dossier-generate-empty"
              loading={refreshingSlot}
              disabled={busy || !canRefresh}
              onClick={onRefresh}
            >
              <Sparkle className="size-4" />
              {t("dossier.action.generateFirst")}
            </Button>
          </div>
        ) : slot.kind === "html" ? (
          <iframe
            data-testid="dossier-html-frame"
            title={slot.title}
            sandbox=""
            srcDoc={body}
            className="h-full min-h-0 w-full flex-1 border-0 bg-bg"
          />
        ) : (
          <DocReader
            content={body}
            status={{
              testId: "dossier-markdown-status",
              text: `r${slot.lastSynthesizedWatermark} / r${currentWatermark}`,
              warn: slot.stalenessDelta > 0,
            }}
          />
        )}
      </div>
    </>
  );
}
