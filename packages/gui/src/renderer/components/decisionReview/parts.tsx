import type { ReactNode } from "react";
import { t } from "../../i18n/index.tsx";
import type { MessageKey } from "../../i18n/core.ts";
import { formatTime } from "../../model/time.ts";
import {
  decisionReviewSignal,
  type DecisionReview,
  type DecisionReviewDispatch,
  type DecisionReviewSignal,
} from "../../model/decision-review.ts";
import type { DecisionReviewState } from "../../model/types.ts";

const SIGNAL_META: Readonly<Record<DecisionReviewSignal, { readonly key: MessageKey; readonly cls: string }>> = {
  reviewing: { key: "views.decisionReview.signalReviewing", cls: "border-accent/40 bg-accent/10 text-accent" },
  changesRequested: {
    key: "views.decisionReview.signalChangesRequested",
    cls: "border-stale/50 bg-stale/10 text-stale",
  },
  unansweredFindings: {
    key: "views.decisionReview.signalUnansweredFindings",
    cls: "border-stale/50 bg-stale/10 text-stale",
  },
  approved: { key: "views.decisionReview.signalApproved", cls: "border-success/40 bg-success/10 text-success" },
  policyUnreviewed: {
    key: "views.decisionReview.signalPolicyUnreviewed",
    cls: "border-border bg-surface-raised text-text-muted",
  },
  unreviewed: { key: "views.decisionReview.signalUnreviewed", cls: "border-border bg-surface-raised text-text-muted" },
};

/** 评审信号徽章:详情页头、工作页与决策池共用;不在待裁状态(无就绪判定)时不渲染。 */
export function DecisionReviewBadge({ review }: { readonly review: DecisionReviewState | undefined }) {
  const signal = decisionReviewSignal(review);
  if (signal === null) return null;
  const meta = SIGNAL_META[signal];
  return (
    <span
      data-testid="decision-review-signal"
      data-signal={signal}
      className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 ui-micro font-semibold ${meta.cls}`}
    >
      {t(meta.key)}
    </span>
  );
}

export function VerdictBadge({ verdict }: { readonly verdict: DecisionReview["verdict"] }) {
  return verdict === "approved" ? (
    <span className="rounded-md border border-success/40 bg-success/10 px-1.5 py-0.5 ui-micro font-semibold text-success">
      {t("views.decisionReview.verdictApproved")}
    </span>
  ) : (
    <span className="rounded-md border border-stale/50 bg-stale/10 px-1.5 py-0.5 ui-micro font-semibold text-stale">
      {t("views.decisionReview.verdictChangesRequested")}
    </span>
  );
}

export function actorText(actor: DecisionReview["actor"]): string {
  return actor.executor ? `agent:${actor.executor.id}` : `human:${actor.principal.personId}`;
}

export function atText(iso: string): string {
  return formatTime(iso, { style: "date-time" }) ?? iso;
}

export function ReviewSection({
  title,
  aside,
  children,
  testId,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <section data-testid={testId} className="grid content-start gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="ui-body font-semibold text-text">{title}</h2>
        {aside ? <span className="font-mono ui-micro text-text-faint">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

export const cardClass = "rounded-lg border border-border bg-surface p-3";
export const primaryButtonClass =
  "rounded-md bg-accent px-2.5 py-1 ui-micro font-semibold text-accent-fg transition-colors duration-100 " +
  "hover:bg-accent/85 disabled:pointer-events-none disabled:opacity-40";
export const secondaryButtonClass =
  "rounded-md border border-border px-2.5 py-1 ui-micro text-text transition-colors duration-100 " +
  "hover:border-border-strong hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-40";

const DISPATCH_STATUS_KEY = {
  running: "views.decisionReview.dispatchRunning",
  succeeded: "views.decisionReview.dispatchSucceeded",
  failed: "views.decisionReview.dispatchFailed",
  unknown: "views.decisionReview.dispatchUnknown",
} as const satisfies Record<DecisionReviewDispatch["status"], MessageKey>;

/** 评审派工的运行状态词:unknown 明说「状态未知」,与「没有评审」分开。 */
export function dispatchStatusText(status: DecisionReviewDispatch["status"]): string {
  return t(DISPATCH_STATUS_KEY[status]);
}
