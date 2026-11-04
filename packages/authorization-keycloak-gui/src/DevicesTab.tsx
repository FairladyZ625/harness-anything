import { useCallback, useState } from "react";
import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import type {
  AccessAdminApi,
  AccessDevice,
  AccessReceipt,
  AccessRejection,
  EdgeJoinIssued,
} from "@harness-anything/authorization-gui/access-admin-contract";
import { createAccessModel } from "./access-model.js";
import { createAccessParts } from "./AccessParts.js";
import type { KeycloakUiHost } from "./ui-host.js";

export function createDevicesTab(host: KeycloakUiHost) {
  const { t, formatTime, IdText, Button, Modal, RecordRow, Region, StatusTag } = host;
  const { isRejection } = createAccessModel(host);
  const { AccessNotice, INPUT, asRejection, useAccessRead } = createAccessParts(host);

  function DevicesTab({
    access,
    auth,
    repoId,
    rootDir,
  }: {
    readonly access: AccessAdminApi;
    readonly auth: OidcAuthApi;
    readonly repoId?: string;
    readonly rootDir?: string;
  }) {
    const readBinding = useCallback(
      async () => (await auth.bindingStatus(repoId, rootDir)) as { readonly ok: true; readonly mode?: string },
      [auth, repoId, rootDir],
    );
    const { data, rejection, reload } = useAccessRead(readBinding);
    if (data && data.mode !== "builtin") return <ManagedDevicesTab key={repoId} access={access} repoId={repoId} />;
    return (
      <Region
        title={t("devices.title")}
        padded
        footer={<Button onClick={() => void reload()}>{t("devices.refresh")}</Button>}
      >
        <div data-testid="my-devices" className="flex flex-col gap-3">
          {rejection ? (
            <AccessNotice rejection={rejection} origin="read" />
          ) : data ? (
            <>
              <p data-testid="devices-local-mode">{t("devices.localMode")}</p>
              <p className="text-text-muted">{t("devices.localCollaboration")}</p>
            </>
          ) : (
            <p role="status">{t("devices.loading")}</p>
          )}
        </div>
      </Region>
    );
  }

  function ManagedDevicesTab({ access, repoId }: { readonly access: AccessAdminApi; readonly repoId?: string }) {
    const { data, rejection, reload } = useAccessRead(access.devices),
      [busy, setBusy] = useState(false),
      [refusal, setRefusal] = useState<AccessRejection | null>(null),
      [editing, setEditing] = useState<AccessDevice | null>(null),
      [name, setName] = useState(""),
      [issued, setIssued] = useState<EdgeJoinIssued | null>(null),
      [copied, setCopied] = useState(false),
      [confirm, setConfirm] = useState<{
        label: string;
        write: () => Promise<({ readonly ok: true } & AccessReceipt) | AccessRejection>;
      } | null>(null);
    async function mutate(write: () => Promise<({ readonly ok: true } & AccessReceipt) | AccessRejection>) {
      setBusy(true);
      try {
        const reply = await write().catch(asRejection);
        setRefusal(isRejection(reply) ? reply : null);
        await reload();
        setConfirm(null);
        if (!isRejection(reply)) setEditing(null);
      } finally {
        setBusy(false);
      }
    }
    async function addDevice() {
      if (!repoId) return;
      setBusy(true);
      setIssued(null);
      setCopied(false);
      try {
        const reply = await access.issueEdgeJoin({ joinMode: "member-device", repoIds: [repoId] }).catch(asRejection);
        setRefusal(isRejection(reply) ? reply : null);
        if (!isRejection(reply)) setIssued(reply);
      } finally {
        setBusy(false);
      }
    }
    async function copyLink() {
      if (!issued) return;
      try {
        await navigator.clipboard.writeText(issued.link);
        setCopied(true);
      } catch (error) {
        setRefusal(asRejection(error));
        return { ok: false };
      }
    }
    return (
      <Region
        title={t("devices.title")}
        footer={
          <Button disabled={busy} onClick={() => void reload()}>
            {t("devices.refresh")}
          </Button>
        }
      >
        <div data-testid="my-devices" className="flex min-h-0 flex-col gap-3 p-3">
          <Button testId="devices-add" disabled={busy || !repoId} onClick={() => void addDevice()}>
            {t("devices.add")}
          </Button>
          {issued && (
            <div data-testid="devices-add-link" className="flex flex-col gap-2">
              <p className="ui-body text-text-muted">{t("devices.addHint")}</p>
              <textarea readOnly aria-label={t("devices.add")} className={INPUT} value={issued.link} />
              <p className="ui-meta text-text-muted">
                {t("devices.addExpires")} {formatTime(issued.expiresAt, { style: "date-time" })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" testId="devices-add-copy" onClick={() => void copyLink()}>
                  {t(copied ? "devices.linkCopied" : "devices.copyLink")}
                </Button>
                <Button testId="devices-add-dismiss" onClick={() => setIssued(null)}>
                  {t("devices.addDone")}
                </Button>
              </div>
            </div>
          )}
          <p className="ui-body text-text-muted" data-testid="devices-security-boundary">
            {t("devices.boundary")}
          </p>
          <p className="ui-body text-text-muted">{t("devices.idle")}</p>
          {rejection && <AccessNotice rejection={rejection} origin="read" />}
          {refusal && <AccessNotice rejection={refusal} origin="write" testId="device-refusal" />}
          {!data && !rejection && <p role="status">{t("devices.loading")}</p>}
          {data && !data.nodes.length && <p data-testid="devices-empty">{t("devices.empty")}</p>}
          {data?.nodes.map((device) => {
            const change = { nodeId: device.nodeId, expectedVersion: device.version };
            return (
              <RecordRow
                key={device.nodeId}
                testId={`device-${device.nodeId}`}
                id={
                  <>
                    <strong>{device.displayName}</strong>
                    <IdText value={device.nodeId} />
                  </>
                }
                state={
                  <StatusTag
                    tone={device.revocation === "pending" ? "bad" : device.state === "paused" ? "wait" : "neutral"}
                    label={t(device.revocation === "pending" ? "devices.pending" : `devices.${device.state}`)}
                  />
                }
                time={formatTime(device.registeredAt, { style: "month-day-time" })}
                summary={
                  <p className="ui-body">
                    {device.personId} · {device.systemName} · {device.platform}
                  </p>
                }
                action={
                  (device.state !== "removed" || device.revocation === "pending") && (
                    <div className="flex flex-wrap gap-2">
                      {device.state !== "removed" && (
                        <Button
                          disabled={busy || device.revocation === "pending"}
                          testId={`device-rename-${device.nodeId}`}
                          onClick={() => {
                            setEditing(device);
                            setName(device.displayName);
                          }}
                        >
                          {t("devices.rename")}
                        </Button>
                      )}
                      {device.state !== "removed" && (
                        <Button
                          disabled={busy}
                          testId={`device-toggle-${device.nodeId}`}
                          onClick={() =>
                            setConfirm({
                              label: t(
                                device.state === "active" || device.revocation === "pending"
                                  ? "devices.pause"
                                  : "devices.resume",
                              ),
                              write: () =>
                                device.state === "active" || device.revocation === "pending"
                                  ? access.pauseDevice(change)
                                  : access.resumeDevice(change),
                            })
                          }
                        >
                          {t(
                            device.state === "active" || device.revocation === "pending"
                              ? "devices.pause"
                              : "devices.resume",
                          )}
                        </Button>
                      )}
                      <Button
                        disabled={busy}
                        testId={`device-remove-${device.nodeId}`}
                        onClick={() =>
                          setConfirm({ label: t("devices.remove"), write: () => access.removeDevice(change) })
                        }
                      >
                        {t("devices.remove")}
                      </Button>
                    </div>
                  )
                }
              />
            );
          })}
          {data && data.nodes.some((node) => node.state !== "removed") && (
            <Button
              testId="devices-logout-all"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  label: t("devices.logoutAll"),
                  write: () => access.logoutDevices({ expectedVersion: data.version }),
                })
              }
            >
              {t("devices.logoutAll")}
            </Button>
          )}
        </div>
        <Modal
          open={editing !== null}
          title={t("devices.rename")}
          onClose={() => {
            if (!busy) setEditing(null);
          }}
          footer={
            editing ? (
              <Button
                disabled={busy || !name.trim()}
                testId="device-save-name"
                onClick={() =>
                  void mutate(() =>
                    access.renameDevice({
                      nodeId: editing.nodeId,
                      expectedVersion: editing.version,
                      displayName: name.trim(),
                    }),
                  )
                }
              >
                {t("devices.save")}
              </Button>
            ) : undefined
          }
        >
          <label className="flex flex-col gap-2">
            {t("devices.name")}
            <input
              className={INPUT}
              data-testid="device-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
        </Modal>
        <Modal
          open={confirm !== null}
          title={confirm?.label ?? ""}
          testId="device-confirmation"
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
          footer={
            confirm ? (
              <Button disabled={busy} testId="device-confirm" onClick={() => void mutate(confirm.write)}>
                {confirm.label}
              </Button>
            ) : undefined
          }
        >
          <p>{t("devices.confirmation")}</p>
        </Modal>
      </Region>
    );
  }
  return { DevicesTab };
}
