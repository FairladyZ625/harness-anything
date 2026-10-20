import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { CheckCircle, ShieldChevron, XCircle } from "@phosphor-icons/react";
import { useEntryMotion } from "../../motion-config.tsx";
import { MOTION_DURATION, MOTION_EASE } from "../../motion-tokens.ts";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { riskTone } from "../badges.tsx";
import { formatTime } from "../../model/time.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";

/**
 * agent-ui 人机裁决卡(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI ApprovalCard 契约):
 * 风险徽标 + 变更/命令预览 + 键盘 Approve/Deny + 悬停自动暂停的超时倒计时,
 * 拍板后经 FLIP 收敛为单行已裁决摘要。自包含 props 驱动,接入点在 W3 审批中心。
 */

export type ApprovalRisk = "low" | "medium" | "high" | "protected";
export type ApprovalVerdict = "approved" | "denied";

export interface ApprovalDecision {
  readonly verdict: ApprovalVerdict;
  /** ISO 时间戳。 */
  readonly at: string;
  readonly by?: string;
  /** 拍板来源:人工键盘/按钮,或倒计时归零的自动拒绝。 */
  readonly reason?: "user" | "timeout";
}

/** 风险徽标的文案源;风险色不在这里另写,统一取 badges.tsx 的 riskTone 映射。 */
const RISK_LABEL: Record<ApprovalRisk, MessageKey> = {
  low: "agentUi.approval.risk.low",
  medium: "agentUi.approval.risk.medium",
  high: "agentUi.approval.risk.high",
  protected: "agentUi.approval.risk.protected",
};

const WARN_REMAINING_MS = 10_000;

function RiskBadge({ risk }: { readonly risk: ApprovalRisk }): ReactNode {
  return (
    <StatusTag
      tone={riskTone(risk)}
      label={t(RISK_LABEL[risk])}
      testId="approval-risk"
      icon={risk === "protected" ? <ShieldChevron weight="bold" aria-hidden /> : undefined}
    />
  );
}

/**
 * 倒计时:1s 步进,悬停/聚焦卡片时暂停(fail-closed:归零自动拒绝)。
 * 暂停即冻结剩余值,恢复后从冻结值继续,不用绝对 deadline(避免暂停语义漂移)。
 */
function useCountdown(timeoutMs: number | null, frozen: boolean, onExpire: () => void): number | null {
  const [remainingMs, setRemainingMs] = useState(timeoutMs);
  const expiredRef = useRef(false);
  useEffect(() => {
    if (timeoutMs === null || frozen) return;
    const id = setInterval(() => {
      setRemainingMs((prev) => (prev === null || prev === 0 ? prev : Math.max(0, prev - 1_000)));
    }, 1_000);
    return () => clearInterval(id);
  }, [timeoutMs, frozen]);
  // 只触发一次:父层未回写 decided 时也不重复拍板。
  useEffect(() => {
    if (timeoutMs === null || expiredRef.current || frozen || remainingMs !== 0) return;
    expiredRef.current = true;
    onExpire();
  }, [remainingMs, timeoutMs, frozen, onExpire]);
  return timeoutMs === null ? null : remainingMs;
}

export function ApprovalCard({
  title,
  summary,
  risk,
  previewLines,
  previewKind = "changes",
  timeoutMs = null,
  decided = null,
  onDecide,
  testId = "approval-card",
}: {
  readonly title: string;
  readonly summary?: string;
  readonly risk: ApprovalRisk;
  /** 变更/命令预览行(逐行渲染,长内容在卡内滚动)。 */
  readonly previewLines?: readonly string[];
  readonly previewKind?: "changes" | "command";
  /** 倒计时毫秒;null = 不限时。归零按拒绝(fail-closed)收口。 */
  readonly timeoutMs?: number | null;
  /** 已裁决态由父层持有(受控);非 null 时卡片收敛为单行摘要。 */
  readonly decided?: ApprovalDecision | null;
  readonly onDecide?: (decision: ApprovalDecision) => void;
  readonly testId?: string;
}) {
  const [attention, setAttention] = useState(false);
  const resolvedRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(decided === null);
  // N6:由待裁决收敛为已裁决时,把焦点交给结果摘要;已是裁决态首次挂载不抢焦点。
  useEffect(() => {
    if (wasPendingRef.current && decided !== null) resolvedRef.current?.focus();
    wasPendingRef.current = decided === null;
  }, [decided]);
  const decide = (verdict: ApprovalVerdict, reason: "user" | "timeout") => {
    if (decided !== null || onDecide === undefined) return;
    onDecide({ verdict, at: new Date().toISOString(), reason });
  };
  const remainingMs = useCountdown(decided === null ? timeoutMs : 0, decided !== null || attention, () =>
    decide("denied", "timeout"),
  );

  // 键盘裁决:Enter 批准,Esc / Shift+Enter 拒绝。焦点在按钮上时让按钮原生激活,不重复拍板。
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (decided !== null) return;
    const onButton = (event.target as HTMLElement).tagName === "BUTTON";
    if (event.key === "Escape") {
      event.preventDefault();
      decide("denied", "user");
    } else if (event.key === "Enter" && !onButton) {
      event.preventDefault();
      decide(event.shiftKey ? "denied" : "approved", "user");
    }
  };

  const { enabled, reduced } = useEntryMotion();
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  return (
    <motion.div
      layout={enabled && !reduced ? true : undefined}
      transition={{ duration: MOTION_DURATION.controlSlide, ease: MOTION_EASE.out }}
      data-testid={testId}
      data-decided={decided?.verdict ?? "pending"}
      role="region"
      aria-label={t("agentUi.approval.regionAria", { title })}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setAttention(true)}
      onPointerLeave={() => setAttention(false)}
      onFocusCapture={() => setAttention(true)}
      onBlurCapture={() => setAttention(false)}
      className="min-w-0 rounded-xl border border-border bg-surface-raised/50"
    >
      {decided === null ? (
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <RiskBadge risk={risk} />
            <span className="min-w-0 flex-1 truncate font-semibold ui-heading text-text">{title}</span>
            {remainingSeconds !== null && (
              <span
                data-testid="approval-countdown"
                data-paused={attention || undefined}
                className={`shrink-0 font-mono ui-micro tabular-nums ${remainingSeconds <= WARN_REMAINING_MS / 1_000 ? "text-danger" : "text-text-faint"}`}
                title={attention ? t("agentUi.approval.countdownPausedTip") : t("agentUi.approval.countdownTip")}
              >
                {attention ? "‖" : ""}
                {remainingSeconds}s
              </span>
            )}
          </div>
          {summary !== undefined && <p className="ui-meta leading-relaxed text-text-muted">{summary}</p>}
          {previewLines !== undefined && previewLines.length > 0 && (
            <pre
              data-testid="approval-preview"
              className="max-h-40 overflow-auto rounded-lg border border-border bg-surface px-2.5 py-2 font-mono ui-micro leading-relaxed text-text"
            >
              {previewKind === "command" ? previewLines.map((line) => `$ ${line}`).join("\n") : previewLines.join("\n")}
            </pre>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono ui-micro text-text-faint">{t("agentUi.approval.kbdHint")}</span>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" testId="approval-deny" onClick={() => decide("denied", "user")}>
                {t("agentUi.approval.deny")}
              </Button>
              <Button variant="primary" testId="approval-approve" onClick={() => decide("approved", "user")}>
                {t("agentUi.approval.approve")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div
          ref={resolvedRef}
          data-testid="approval-resolved"
          tabIndex={-1}
          className="flex min-w-0 items-center gap-2 px-3 py-2 ui-meta"
        >
          {decided.verdict === "approved" ? (
            <CheckCircle weight="bold" aria-hidden className="shrink-0 text-success" />
          ) : (
            <XCircle weight="bold" aria-hidden className="shrink-0 text-danger" />
          )}
          <span className="shrink-0 font-semibold text-text">
            {decided.verdict === "approved"
              ? t("agentUi.approval.resolvedApproved")
              : t("agentUi.approval.resolvedDenied")}
          </span>
          {decided.reason === "timeout" && (
            <span className="shrink-0 ui-micro text-text-faint">{t("agentUi.approval.resolvedTimeout")}</span>
          )}
          <span className="min-w-0 flex-1 truncate text-text-muted">{title}</span>
          <RiskBadge risk={risk} />
          <span className="shrink-0 font-mono ui-micro text-text-faint">
            {formatTime(decided.at, { style: "time" }) ?? ""}
          </span>
        </div>
      )}
    </motion.div>
  );
}
