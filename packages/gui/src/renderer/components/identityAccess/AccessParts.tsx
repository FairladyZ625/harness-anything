import { useCallback, useEffect, useState } from "react";
import type { AccessReceipt, AccessRejection } from "../../../api/access-admin-contract.ts";
import { isPermissionRefusal, isRejection, receiptTitle, rejectionText } from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import { Button } from "../primitives/Button.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";

export const INPUT =
  "min-w-0 rounded-xs border border-border bg-surface-raised px-2.5 py-1.5 text-text ui-body outline-none placeholder:text-text-faint focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-50";

type AccessReply<T> = ({ readonly ok: true } & T) | AccessRejection;

/** A request that never reached the daemon reads like any other refusal. */
export function asRejection(error: unknown): AccessRejection {
  return {
    ok: false,
    code: "access_request_failed",
    rejectionExplanation: error instanceof Error ? error.message : String(error),
  };
}

/** One daemon read: its answer, or the refusal that stands in for it. */
export function useAccessRead<T>(read: (() => Promise<AccessReply<T>>) | undefined): {
  readonly data: T | null;
  readonly rejection: AccessRejection | null;
  readonly reload: () => Promise<T | null>;
} {
  const [state, setState] = useState<{ readonly data: T | null; readonly rejection: AccessRejection | null }>({
    data: null,
    rejection: null,
  });
  const reload = useCallback(async () => {
    if (!read) return null;
    const reply = await read().catch(asRejection);
    if (isRejection(reply)) {
      setState({ data: null, rejection: reply });
      return null;
    }
    setState({ data: reply, rejection: null });
    return reply as T;
  }, [read]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

/** Where a refusal came from: a read the page made on its own, or a write the person asked for. */
export type RefusalOrigin = "read" | "write";

export function AccessNotice({
  rejection,
  origin,
  testId,
}: {
  readonly rejection: AccessRejection;
  readonly origin: RefusalOrigin;
  readonly testId?: string;
}) {
  // Only a read the page made may render its legal lack of role as information; a write the person
  // asked for keeps clear error feedback, and every other refusal still reads as a failure.
  const permission = origin === "read" && isPermissionRefusal(rejection);
  return (
    <p
      role={permission ? "status" : "alert"}
      data-testid={testId}
      data-code={rejection.code}
      className={
        permission
          ? "border-l-2 border-border px-3 py-2 text-text-muted ui-meta"
          : "border-l-2 border-status-blocked bg-status-blocked/5 px-3 py-2 text-status-blocked ui-meta"
      }
    >
      {rejectionText(rejection)}
    </p>
  );
}

const OUTCOME: Readonly<Record<string, { readonly tone: StatusTone; readonly label: () => string }>> = {
  applied: { tone: "done", label: () => t("accessControl.receipt.applied") },
  failed: { tone: "bad", label: () => t("accessControl.receipt.failed") },
  version_conflict: { tone: "wait", label: () => t("accessControl.receipt.versionConflict") },
};

/** Audit receipts, newest first. An operation without a settled receipt offers reconciliation by its id. */
export function ReceiptRows({
  receipts,
  busy,
  onReconcile,
}: {
  readonly receipts: readonly AccessReceipt[];
  readonly busy: boolean;
  readonly onReconcile?: (operationId: string) => void;
}) {
  return (
    <>
      {receipts.map((receipt) => {
        const outcome = receipt.phase === "settled" ? OUTCOME[receipt.outcome ?? ""] : undefined,
          at = receipt.settledAt ?? receipt.recordedAt;
        return (
          <DenseRow
            key={receipt.operationId}
            relaxed
            tag={
              // One width for every outcome, so the titles line up down the list.
              <span className="inline-block min-w-[4.5rem]">
                <StatusTag
                  tone={outcome?.tone ?? "bad"}
                  label={outcome?.label() ?? t("accessControl.receipt.unsettled")}
                />
              </span>
            }
            title={receiptTitle(receipt)}
            reason={
              <span>
                {receipt.actor}
                <details className="text-text-faint">
                  <summary className="cursor-pointer">{t("accessControl.receipt.details")}</summary>
                  <code>{receipt.operationId}</code>
                </details>
              </span>
            }
            time={
              receipt.phase === "intent" && onReconcile ? (
                <Button
                  size="sm"
                  disabled={busy}
                  testId={`receipt-reconcile-${receipt.operationId}`}
                  onClick={() => onReconcile(receipt.operationId)}
                >
                  {t("accessControl.receipt.reconcile")}
                </Button>
              ) : at ? (
                formatTime(at, { style: "month-day-time" })
              ) : undefined
            }
          />
        );
      })}
    </>
  );
}
