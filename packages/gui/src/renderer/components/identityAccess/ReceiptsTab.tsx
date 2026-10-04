import { useState } from "react";
import type { AccessAdminApi, AccessReceipt, AccessRejection } from "../../../api/access-admin-contract.ts";
import { isRejection } from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, RegionBoard } from "../primitives/RegionBoard.tsx";
import { AccessNotice, ReceiptRows, asRejection, useAccessRead } from "./AccessParts.tsx";

/**
 * The audit trail of access administration. Nothing here takes part in a decision: Keycloak holds
 * the state that is evaluated, and these rows say who changed it. An operation without a settled
 * receipt is reconciled by its id against what Keycloak shows, never repeated.
 */
export function ReceiptsTab({ access }: { readonly access: AccessAdminApi }) {
  const { data, rejection, reload } = useAccessRead<{ readonly receipts: readonly AccessReceipt[] }>(access.receipts),
    [busy, setBusy] = useState(false),
    [refusal, setRefusal] = useState<AccessRejection | null>(null);
  const reconcile = async (operationId: string) => {
    setBusy(true);
    // A reconciliation that finds the write never took effect settles the operation as failed; the row then says so.
    const reply = await access.reconcile({ operationId }).catch(asRejection);
    setRefusal(isRejection(reply) && reply.code ? reply : null);
    await reload();
    setBusy(false);
  };
  if (rejection) return <AccessNotice rejection={rejection} origin="read" testId="access-receipts-unavailable" />;
  if (!data) return <p className="text-text-muted ui-meta">{t("accessControl.loading")}</p>;
  const unsettled = data.receipts.filter((receipt) => receipt.phase === "intent").length;
  return (
    <RegionBoard data-testid="access-receipts-board">
      <BoardMain>
        <BoardColumn>
          <BoardRegion region="receipts" fill data-testid="access-receipts">
            <Region
              title={t("accessControl.receipts.title")}
              big={data.receipts.length}
              edge={unsettled > 0 ? "bad" : undefined}
              footer={
                unsettled > 0
                  ? t("accessControl.receipts.unsettledFooter", { count: unsettled })
                  : t("accessControl.receipts.footer")
              }
            >
              {refusal && <AccessNotice rejection={refusal} origin="write" testId="access-receipt-refusal" />}
              <ReceiptRows receipts={data.receipts} busy={busy} onReconcile={(id) => void reconcile(id)} />
            </Region>
          </BoardRegion>
        </BoardColumn>
      </BoardMain>
    </RegionBoard>
  );
}
