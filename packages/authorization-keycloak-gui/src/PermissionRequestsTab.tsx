import { useEffect, useState } from "react";
import type { AccessAdminApi, PermissionRequest } from "@harness-anything/authorization-gui/access-admin-contract";
import { createAccessParts } from "./AccessParts.js";
import { createAccessModel } from "./access-model.js";
import type { KeycloakUiHost } from "./ui-host.js";

export function createPermissionRequestsTab(host: KeycloakUiHost) {
  const { Button, Region, Modal, t, IdText } = host;
  const { resourceLabel, roleLabel } = createAccessModel(host);
  const { useAccessRead, asRejection, AccessNotice, INPUT } = createAccessParts(host);
  const { isRejection } = createAccessModel(host);

  function PermissionRequestsTab({ access, identity }: { readonly access: AccessAdminApi; readonly identity: string }) {
    const { data, rejection, reload } = useAccessRead(access.permissionRequests),
      [groupId, setGroupId] = useState("viewer"),
      [resource, setResource] = useState(""),
      [rationale, setRationale] = useState(""),
      [confirming, setConfirming] = useState<PermissionRequest | null>(null),
      [busy, setBusy] = useState(false),
      [failure, setFailure] = useState<unknown>(null);
    useEffect(() => {
      const refresh = () => void reload();
      window.addEventListener("harness-auth-changed", refresh);
      return () => window.removeEventListener("harness-auth-changed", refresh);
    }, [reload]);
    const create = async () => {
      setBusy(true);
      setFailure(null);
      const result = await access
        .requestPermission({
          groupId,
          resource,
          ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        })
        .catch(asRejection);
      if (isRejection(result)) setFailure(result);
      else await reload();
      setBusy(false);
    };
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
      <Region title={t("accessControl.requests.title")}>
        <form
          className="flex flex-wrap items-end gap-3 px-3 py-3"
          data-testid="permission-request-create"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 ui-meta">
            {t("accessControl.requests.policyGroup")}
            <input
              className={INPUT}
              required
              value={groupId}
              onChange={(event) => setGroupId(event.currentTarget.value)}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 ui-meta">
            {t("accessControl.requests.resource")}
            <input
              className={INPUT}
              required
              value={resource}
              onChange={(event) => setResource(event.currentTarget.value)}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 ui-meta">
            {t("accessControl.requests.reason")}
            <input className={INPUT} value={rationale} onChange={(event) => setRationale(event.currentTarget.value)} />
          </label>
          <Button type="submit" disabled={busy || !groupId.trim() || !resource.trim()}>
            {t("accessControl.requests.submit")}
          </Button>
        </form>
        {failure !== null && (
          <AccessNotice
            rejection={failure as import("@harness-anything/authorization-gui/access-admin-contract").AccessRejection}
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
                  <b>
                    <IdText value={request.personId} />
                  </b>{" "}
                  {t("accessControl.requests.requested")} {roleLabel(request.groupId)} ·{" "}
                  {resourceLabel(request.resource)}
                </p>
                <p className="text-text-muted ui-meta">
                  {t("accessControl.requests.versionActions", {
                    version: request.version,
                    actions: request.actions.join(", "),
                  })}
                  {request.rationale ? ` · ${t("accessControl.requests.reasonPrefix")}: ${request.rationale}` : ""}
                </p>
              </div>
              {request.state === "pending" &&
                (request.personId === identity ? (
                  <Button
                    testId={`permission-request-withdraw-${request.requestId}`}
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setFailure(null);
                      void access
                        .withdrawPermissionRequest({ requestId: request.requestId, requestVersion: request.version })
                        .catch(asRejection)
                        .then(async (result) => {
                          if (isRejection(result)) setFailure(result);
                          else await reload();
                          setBusy(false);
                        });
                    }}
                  >
                    {t("accessControl.requests.withdraw")}
                  </Button>
                ) : data.canDecide ? (
                  <Button
                    testId={`permission-request-decide-${request.requestId}`}
                    onClick={() => setConfirming(request)}
                  >
                    {t("accessControl.requests.review")}
                  </Button>
                ) : null)}
              {request.state === "pending" && request.personId === identity && (
                <p className="w-full text-text-muted ui-meta" role="note">
                  {t("accessControl.requests.requesterCannotDecide")}
                </p>
              )}
              {request.state !== "pending" && (
                <span className="ui-meta">{t(`accessControl.requests.state.${request.state}` as const)}</span>
              )}
            </article>
          ))}
          {data.requests.length === 0 && (
            <p className="px-3 py-3 text-text-muted ui-body">{t("accessControl.requests.empty")}</p>
          )}
        </div>
        <Modal
          open={confirming !== null}
          title={t("accessControl.requests.confirmTitle")}
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
                {t("accessControl.requests.approve")}
              </Button>
              <Button testId="permission-request-reject" disabled={busy} onClick={() => void decide("reject")}>
                {t("accessControl.requests.reject")}
              </Button>
            </div>
          }
        >
          {confirming && (
            <>
              <p className="ui-body">
                {t("accessControl.requests.confirmVersion", { version: confirming.version })}:{" "}
                <IdText value={confirming.personId} /> · {roleLabel(confirming.groupId)} ·{" "}
                {resourceLabel(confirming.resource)}
              </p>
              <p className="text-text-muted ui-meta">{confirming.actions.join(", ")}</p>
            </>
          )}
        </Modal>
      </Region>
    );
  }
  return { PermissionRequestsTab };
}
