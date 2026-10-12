import { useState } from "react";
import type { AccessAdminApi, PermissionRequest } from "../../../api/access-admin-contract.ts";
import { Button } from "../primitives/Button.tsx";
import { Region } from "../primitives/Region.tsx";
import { Modal } from "../primitives/Modal.tsx";
import { resourceLabel, roleLabel } from "../../access-model.ts";
import { useAccessRead, asRejection, AccessNotice } from "./AccessParts.tsx";
import { isRejection } from "../../access-model.ts";

export function PermissionRequestsTab({ access }: { readonly access: AccessAdminApi }) {
  const { data, rejection, reload } = useAccessRead(access.permissionRequests),
    [confirming, setConfirming] = useState<PermissionRequest | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<unknown>(null);
  const decide = async (decision: "approve" | "reject") => {
    if (!confirming) return;
    setBusy(true);
    setFailure(null);
    const result = await access
      .decidePermissionRequest({ requestId: confirming.requestId, requestVersion: confirming.version, decision })
      .catch(asRejection);
    if (isRejection(result)) setFailure(result);
    else await reload();
    setConfirming(null);
    setBusy(false);
  };
  if (rejection) return <AccessNotice rejection={rejection} origin="read" />;
  if (!data) return <p role="status">正在读取权限申请…</p>;
  return (
    <Region title="Permission requests">
      {failure !== null && (
        <AccessNotice
          rejection={failure as import("../../../api/access-admin-contract.ts").AccessRejection}
          origin="write"
        />
      )}
      <div className="divide-y divide-border" data-testid="permission-requests">
        {data.requests.map((request) => (
          <article
            key={request.requestId}
            className="flex flex-wrap items-center gap-3 px-3 py-3"
            data-request-version={request.version}
          >
            <div className="min-w-0 flex-1">
              <p className="ui-body">
                <b>{request.personId}</b> requests {roleLabel(request.groupId)} · {resourceLabel(request.resource)}
              </p>
              <p className="text-text-muted ui-meta">
                Version {request.version} · {request.actions.join(", ")}
                {request.rationale ? ` · ${request.rationale}` : ""}
              </p>
            </div>
            {request.state === "pending" && (
              <Button testId={`permission-request-decide-${request.requestId}`} onClick={() => setConfirming(request)}>
                Review and decide
              </Button>
            )}
            {request.state !== "pending" && <span className="ui-meta">{request.state}</span>}
          </article>
        ))}
        {data.requests.length === 0 && <p className="px-3 py-3 text-text-muted ui-body">No pending requests.</p>}
      </div>
      {confirming && (
        <Modal
          title="Confirm permission request"
          testId="permission-request-confirm"
          onClose={() => !busy && setConfirming(null)}
          footer={
            <div className="flex gap-2">
              <Button
                testId="permission-request-approve"
                variant="primary"
                disabled={busy}
                onClick={() => void decide("approve")}
              >
                Approve
              </Button>
              <Button testId="permission-request-reject" disabled={busy} onClick={() => void decide("reject")}>
                Reject
              </Button>
            </div>
          }
        >
          <p className="ui-body">
            Confirm version {confirming.version}: {confirming.personId} · {roleLabel(confirming.groupId)} ·{" "}
            {resourceLabel(confirming.resource)}
          </p>
          <p className="text-text-muted ui-meta">{confirming.actions.join(", ")}</p>
        </Modal>
      )}
    </Region>
  );
}
