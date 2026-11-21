import type { RuntimeQuotaWindowV1, RuntimeSubscriptionQuotaV1 } from "@harness-anything/daemon/protocol";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { StatusTag, TONE_COLOR } from "../primitives/StatusTag.tsx";
import { Card, CardBody, CardHead, CardTitle, Right } from "./parts.tsx";

function remainingPercent(window: RuntimeQuotaWindowV1): number {
  return Math.round(Math.max(0, Math.min(1, window.remainingFraction)) * 100);
}

function remainingPercentText(window: RuntimeQuotaWindowV1): string {
  const clamped = Math.max(0, Math.min(1, window.remainingFraction)),
    percent = Math.round(clamped * 100);
  return clamped > 0 && percent === 0 ? "<1%" : `${percent}%`;
}

function quotaTone(fraction: number): "bad" | "wait" | "done" {
  if (fraction <= 0) return "bad";
  if (fraction <= 0.2) return "wait";
  return "done";
}

function tightestWindow(quota: RuntimeSubscriptionQuotaV1): RuntimeQuotaWindowV1 | null {
  const primary = quota.windows.filter((window) => window.scope !== "auxiliary");
  const candidates = primary.length > 0 ? primary : quota.windows;
  let lowest: RuntimeQuotaWindowV1 | null = null;
  for (const window of candidates) {
    if (lowest === null || window.remainingFraction < lowest.remainingFraction) lowest = window;
  }
  return lowest;
}

function formatCreditNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/u, "");
}

export function RuntimeQuotaCard({ quota }: { readonly quota: RuntimeSubscriptionQuotaV1 }) {
  const exhausted = quota.windows.some((window) => window.scope !== "auxiliary" && window.remainingFraction <= 0);
  const observed = formatTime(quota.observedAt, { style: "time" }) ?? quota.observedAt;
  return (
    <Card testId="runtime-card-quota">
      <CardHead>
        <CardTitle>{t("agentRuntime.quotaTitle")}</CardTitle>
        {quota.plan ? <StatusTag tone="neutral" mono label={quota.plan} /> : null}
        {exhausted ? <StatusTag tone="bad" label={t("agentRuntime.quotaExhausted")} /> : null}
        <Right>
          <span className="font-mono ui-micro text-text-faint" data-testid="runtime-quota-observed">
            {observed}
          </span>
        </Right>
      </CardHead>
      <CardBody>
        <div className="grid gap-2.5" data-testid="runtime-quota-windows">
          {quota.windows.map((window) => {
            const percent = remainingPercent(window),
              percentLabel = remainingPercentText(window),
              tone = quotaTone(window.remainingFraction),
              reset = window.resetsAt
                ? (formatTime(window.resetsAt, { style: "date-time-seconds" }) ?? window.resetsAt)
                : null;
            return (
              <div key={window.id} data-testid={`runtime-quota-window-${window.id}`} className="grid gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="ui-meta font-medium text-text">{window.label}</span>
                  <span className="flex items-baseline gap-2 font-mono ui-micro">
                    <span
                      className="font-semibold tabular-nums"
                      style={{ color: tone === "done" ? "var(--color-text)" : TONE_COLOR[tone] }}
                    >
                      {percentLabel}
                    </span>
                    {reset ? (
                      <span className="text-text-faint">{t("agentRuntime.quotaResetsAt", { time: reset })}</span>
                    ) : null}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={t("agentRuntime.quotaWindowAria", { label: window.label, percent })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="h-1.5 w-full overflow-hidden rounded-xs bg-text/10"
                >
                  <span
                    className="block h-full"
                    style={{
                      width: `${window.remainingFraction > 0 && percent === 0 ? 1 : percent}%`,
                      background: TONE_COLOR[tone],
                    }}
                  />
                </div>
              </div>
            );
          })}
          {quota.credits ? (
            <div
              data-testid="runtime-quota-credits"
              className="flex items-baseline justify-between gap-2 border-t border-border pt-2 font-mono ui-micro"
            >
              <span className="text-text-muted">{t("agentRuntime.quotaCredits")}</span>
              <span className="tabular-nums text-text">
                {quota.credits.unlimited
                  ? t("agentRuntime.quotaUnlimited")
                  : quota.credits.remaining !== null && quota.credits.limit !== null
                    ? `${formatCreditNumber(quota.credits.remaining)} / ${formatCreditNumber(quota.credits.limit)}`
                    : quota.credits.remaining !== null
                      ? formatCreditNumber(quota.credits.remaining)
                      : "-"}
              </span>
            </div>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

export function RuntimeQuotaRailBadge({ quota }: { readonly quota: RuntimeSubscriptionQuotaV1 }) {
  const lowest = tightestWindow(quota);
  if (!lowest) return null;
  const percentLabel = remainingPercentText(lowest),
    tone = lowest.remainingFraction <= 0 ? "bad" : lowest.remainingFraction <= 0.2 ? "wait" : "neutral",
    fullReset = lowest.resetsAt
      ? (formatTime(lowest.resetsAt, { style: "date-time-seconds" }) ?? lowest.resetsAt)
      : null,
    compactReset = lowest.resetsAt ? (formatTime(lowest.resetsAt, { style: "time" }) ?? lowest.resetsAt) : null,
    summaryLabel = `${lowest.label} ${percentLabel}`,
    accessibleLabel = fullReset
      ? `${summaryLabel} · ${t("agentRuntime.quotaResetsAt", { time: fullReset })}`
      : summaryLabel;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      data-testid="rail-runtime-quota"
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      <StatusTag tone={tone} mono label={summaryLabel} />
      {compactReset ? (
        <span className="font-mono ui-micro text-text-faint" data-testid="rail-runtime-quota-reset">
          {compactReset}
        </span>
      ) : null}
    </span>
  );
}
