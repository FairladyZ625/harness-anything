import { useState } from "react";
import type {
  AccessAdminApi,
  AccessDevice,
  AccessReceipt,
  AccessRejection,
} from "../../../api/access-admin-contract.ts";
import { isRejection } from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { AccessNotice, INPUT, asRejection } from "../../components/identityAccess/AccessParts.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { Modal } from "../../components/primitives/Modal.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import type { FleetOverviewNode } from "../../../api/renderer-dto.ts";

/**
 * 节点详情抽屉里的「设备管理」区(2026-10-13 业主裁定 F-1C074F8F/F-AF9848DC:在协作
 * 界面点节点即可管理设备,不在 RBAC 面与设置面之间跳转)。操作全部走 daemon 既有
 * device-* 命令面(与「我的设备」页同一通道:expectedVersion 乐观锁 + 审计回执),
 * 这里不新造权限路径:设备挂在人账号下,daemon 只允许 owner 管理自己的设备——不是
 * 当前账号的节点如实标注不可管理。危险操作(移除/退出全部会话)与状态切换都过
 * 确认框;改名是显式保存,不需要二次确认。
 */

type DeviceWrite = () => Promise<({ readonly ok: true } & AccessReceipt) | AccessRejection>;

/** 确认框的形状:danger 只给不可逆/大范围操作(移除、退出全部会话),暂停/恢复是可逆切换。 */
type DeviceConfirm = {
  readonly label: string;
  readonly variant: "plain" | "danger";
  readonly write: DeviceWrite;
};

export function NodeManagement({
  node,
  access,
  devicesList,
  devicesRejection,
  reloadDevices,
  onMutated,
}: {
  readonly node: FleetOverviewNode;
  /** Electron 桥的 access 面;浏览器预览没有,如实标注而不是隐藏入口。 */
  readonly access: AccessAdminApi | undefined;
  readonly devicesList: { readonly nodes: readonly AccessDevice[]; readonly version: string } | null;
  readonly devicesRejection: AccessRejection | null;
  readonly reloadDevices: () => Promise<unknown>;
  /** 写操作成功后重读舰队拓扑(节点状态/隐藏集合随新事实变化)。 */
  readonly onMutated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<AccessRejection | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<DeviceConfirm | null>(null);
  const device = devicesList === null ? null : (devicesList.nodes.find((row) => row.nodeId === node.nodeId) ?? null);
  const hasActiveDevices = devicesList?.nodes.some((row) => row.state !== "removed") ?? false;

  async function mutate(write: DeviceWrite) {
    if (access === undefined) return;
    setBusy(true);
    try {
      const reply = await write().catch(asRejection);
      setRefusal(isRejection(reply) ? reply : null);
      await reloadDevices();
      setConfirm(null);
      if (!isRejection(reply)) {
        setEditing(false);
        onMutated();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="collaboration-node-management" className="flex flex-col gap-2.5">
      <h3 className="font-semibold ui-body">{t("collaboration.manageTitle")}</h3>
      <p className="ui-micro text-text-faint">{t("collaboration.manageNote")}</p>
      {devicesRejection !== null ? (
        <AccessNotice rejection={devicesRejection} origin="read" testId="collaboration-management-read-refusal" />
      ) : null}
      {refusal !== null ? (
        <AccessNotice rejection={refusal} origin="write" testId="collaboration-management-refusal" />
      ) : null}
      {access === undefined ? (
        <p data-testid="collaboration-management-unavailable" className="ui-meta text-text-muted">
          {t("collaboration.manageUnavailable")}
        </p>
      ) : device === null ? (
        devicesRejection === null && devicesList !== null ? (
          <p data-testid="collaboration-management-not-owned" className="ui-meta text-text-muted">
            {t("collaboration.manageNotOwned")}
          </p>
        ) : devicesList === null ? (
          <p role="status" className="ui-meta text-text-muted">
            {t("collaboration.manageLoading")}
          </p>
        ) : null
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusTag
              tone={device.revocation === "pending" ? "bad" : device.state === "paused" ? "wait" : "neutral"}
              label={t(device.revocation === "pending" ? "devices.pending" : `devices.${device.state}`)}
            />
            <span className="min-w-0 break-all font-semibold ui-body">{device.displayName}</span>
            <span className="text-text-faint ui-micro">
              {device.systemName} · {device.platform}
            </span>
          </div>
          {device.state !== "removed" || device.revocation === "pending" ? (
            <div className="flex flex-wrap gap-2">
              {device.state !== "removed" ? (
                <Button
                  size="sm"
                  disabled={busy || device.revocation === "pending"}
                  testId={`collaboration-device-rename-${node.nodeId}`}
                  onClick={() => {
                    setEditing(true);
                    setName(device.displayName);
                  }}
                >
                  {t("devices.rename")}
                </Button>
              ) : null}
              {device.state !== "removed" ? (
                <Button
                  size="sm"
                  disabled={busy}
                  testId={`collaboration-device-toggle-${node.nodeId}`}
                  onClick={() =>
                    setConfirm({
                      label: t(
                        device.state === "active" || device.revocation === "pending"
                          ? "devices.pause"
                          : "devices.resume",
                      ),
                      variant: "plain",
                      write: () =>
                        device.state === "active" || device.revocation === "pending"
                          ? access.pauseDevice({ nodeId: device.nodeId, expectedVersion: device.version })
                          : access.resumeDevice({ nodeId: device.nodeId, expectedVersion: device.version }),
                    })
                  }
                >
                  {t(device.state === "active" || device.revocation === "pending" ? "devices.pause" : "devices.resume")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                testId={`collaboration-device-remove-${node.nodeId}`}
                onClick={() =>
                  setConfirm({
                    label: t("devices.remove"),
                    variant: "danger",
                    write: () => access.removeDevice({ nodeId: device.nodeId, expectedVersion: device.version }),
                  })
                }
              >
                {t("devices.remove")}
              </Button>
              {hasActiveDevices ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  testId="collaboration-device-logout-all"
                  onClick={() =>
                    setConfirm({
                      label: t("devices.logoutAll"),
                      variant: "danger",
                      write: () => access.logoutDevices({ expectedVersion: devicesList!.version }),
                    })
                  }
                >
                  {t("devices.logoutAll")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {hasActiveDevices ? (
            <p className="ui-micro text-text-faint">{t("collaboration.manageLogoutAllScope")}</p>
          ) : null}
        </>
      )}
      {editing && device !== null ? (
        <Modal
          title={t("devices.rename")}
          onClose={() => {
            if (!busy) setEditing(false);
          }}
          footer={
            <Button
              size="sm"
              disabled={busy || !name.trim()}
              testId="collaboration-device-save-name"
              onClick={() =>
                void mutate(() =>
                  access!.renameDevice({
                    nodeId: device.nodeId,
                    expectedVersion: device.version,
                    displayName: name.trim(),
                  }),
                )
              }
            >
              {t("devices.save")}
            </Button>
          }
        >
          <label className="flex flex-col gap-2">
            {t("devices.name")}
            <input
              className={INPUT}
              data-testid="collaboration-device-name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
        </Modal>
      ) : null}
      {confirm !== null ? (
        <Modal
          title={confirm.label}
          testId="collaboration-device-confirmation"
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
          footer={
            <Button
              size="sm"
              variant={confirm.variant}
              disabled={busy}
              testId="collaboration-device-confirm"
              onClick={() => void mutate(confirm.write)}
            >
              {confirm.label}
            </Button>
          }
        >
          <p>{t("devices.confirmation")}</p>
        </Modal>
      ) : null}
    </div>
  );
}
