import type { IpcMainInvokeEvent } from "electron";
import {
  checkEdgeUpgradeStatus,
  runEdgeUpgrade,
  type EdgeUpgradeOptions,
  type EdgeUpgradeProgress,
  type EdgeUpgradeReceipt,
  type EdgeUpgradeStatusReport,
} from "@harness-anything/daemon/internal/client/edge-upgrade";
import {
  EDGE_UPGRADE_PROGRESS_EVENT,
  EDGE_UPGRADE_RELAUNCH_CHANNEL,
  EDGE_UPGRADE_RUN_CHANNEL,
  EDGE_UPGRADE_STATUS_CHANNEL,
  type EdgeUpgradeGuiRunInput,
  type EdgeUpgradeGuiStatus,
} from "../api/edge-upgrade-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

interface Registrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>,
  ) => void;
}

interface BroadcastTarget {
  readonly isDestroyed: () => boolean;
  readonly webContents: { readonly send: (channel: string, payload: EdgeUpgradeProgress) => void };
}

export interface EdgeUpgradeIpcPorts {
  readonly isPackaged: boolean;
  readonly userRoot: () => string;
  readonly daemonId: () => string;
  readonly targets: () => readonly BroadcastTarget[];
  readonly relaunch: () => void;
  readonly checkStatus?: (
    options: Omit<EdgeUpgradeOptions, "toRef" | "offline" | "rollback">,
  ) => Promise<EdgeUpgradeStatusReport>;
  readonly executeUpgrade?: (options: EdgeUpgradeOptions) => Promise<EdgeUpgradeReceipt>;
}

const REPO_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/@^~-]{1,128}$/u;

export function registerEdgeUpgradeIpc(
  registrar: Registrar,
  trustPolicy: IpcWebContentsTrustPolicy,
  ports: EdgeUpgradeIpcPorts,
): void {
  const checkStatus = ports.checkStatus ?? checkEdgeUpgradeStatus;
  const executeUpgrade = ports.executeUpgrade ?? runEdgeUpgrade;
  let inProgress = false;

  const publishProgress = (progress: EdgeUpgradeProgress): void => {
    for (const target of ports.targets()) {
      if (!target.isDestroyed()) target.webContents.send(EDGE_UPGRADE_PROGRESS_EVENT, progress);
    }
  };

  registrar.handle(EDGE_UPGRADE_STATUS_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const repoId = parseStatusRepoId(payload);
    if (ports.isPackaged) {
      return {
        mode: "packaged",
        ok: true,
        installRoot: null,
        repoId: repoId ?? null,
        localCommit: null,
        daemonCommit: null,
        centerCommit: null,
        updateAvailable: false,
        canRollback: false,
        previousCommit: null,
        inProgress: false,
      } satisfies EdgeUpgradeGuiStatus;
    }
    const status = await checkStatus({
      userRoot: ports.userRoot(),
      daemonId: ports.daemonId(),
      ...(repoId ? { repoId } : {}),
    });
    return {
      mode: "source",
      ok: status.ok,
      installRoot: status.installRoot,
      repoId: status.repoId,
      localCommit: status.localCommit,
      daemonCommit: status.daemonCommit,
      centerCommit: status.centerCommit,
      updateAvailable: status.updateAvailable,
      canRollback: status.canRollback,
      previousCommit: status.previousCommit,
      inProgress,
      ...(status.reason ? { reason: status.reason } : {}),
    } satisfies EdgeUpgradeGuiStatus;
  });

  registrar.handle(EDGE_UPGRADE_RUN_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const request = parseEdgeUpgradeRunInput(payload);
    if (ports.isPackaged) {
      throw new Error("Packaged desktop apps update through the signed release updater.");
    }
    if (inProgress) {
      throw new Error("An edge upgrade is already in progress.");
    }
    inProgress = true;
    try {
      return await executeUpgrade({
        userRoot: ports.userRoot(),
        daemonId: ports.daemonId(),
        ...(request.repoId ? { repoId: request.repoId } : {}),
        ...(request.toRef ? { toRef: request.toRef } : {}),
        ...(request.offline !== undefined ? { offline: request.offline } : {}),
        ...(request.rollback !== undefined ? { rollback: request.rollback } : {}),
        onProgress: publishProgress,
      });
    } finally {
      inProgress = false;
    }
  });

  registrar.handle(EDGE_UPGRADE_RELAUNCH_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined) {
      throw new Error("Edge upgrade relaunch does not accept a payload.");
    }
    ports.relaunch();
  });
}

function parseStatusRepoId(payload: unknown): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Edge upgrade status payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "repoId");
  if (unknown.length > 0) throw new Error(`Edge upgrade status does not take ${unknown.join(", ")}.`);
  if (record.repoId === undefined) return undefined;
  if (typeof record.repoId !== "string" || !REPO_ID_PATTERN.test(record.repoId)) {
    throw new Error("Edge upgrade status repoId is invalid.");
  }
  return record.repoId;
}

export function parseEdgeUpgradeRunInput(payload: unknown): EdgeUpgradeGuiRunInput {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Edge upgrade request payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  const allowed = ["repoId", "toRef", "offline", "rollback"];
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Edge upgrade does not take ${unknown.join(", ")}.`);
  if (record.repoId !== undefined && (typeof record.repoId !== "string" || !REPO_ID_PATTERN.test(record.repoId))) {
    throw new Error("Edge upgrade repoId is invalid.");
  }
  if (
    record.toRef !== undefined &&
    (typeof record.toRef !== "string" ||
      !SAFE_REF_PATTERN.test(record.toRef.trim()) ||
      record.toRef.trim().startsWith("-"))
  ) {
    throw new Error("Edge upgrade toRef must be a valid git ref or commit.");
  }
  if (record.offline !== undefined && typeof record.offline !== "boolean") {
    throw new Error("Edge upgrade offline must be a boolean.");
  }
  if (record.rollback !== undefined && typeof record.rollback !== "boolean") {
    throw new Error("Edge upgrade rollback must be a boolean.");
  }
  if (record.rollback === true && record.toRef !== undefined) {
    throw new Error("Edge upgrade cannot combine rollback with toRef.");
  }
  return {
    ...(typeof record.repoId === "string" ? { repoId: record.repoId } : {}),
    ...(typeof record.toRef === "string" ? { toRef: record.toRef.trim() } : {}),
    ...(typeof record.offline === "boolean" ? { offline: record.offline } : {}),
    ...(typeof record.rollback === "boolean" ? { rollback: record.rollback } : {}),
  };
}
