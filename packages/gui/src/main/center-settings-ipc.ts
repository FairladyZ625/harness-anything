import { isMirrorQuotaValid } from "@harness-anything/kernel/internal/domain/gui-admission-policy.ts";
import {
  rbacBackupStatuses,
  type RbacBackupStatus,
} from "@harness-anything/kernel/internal/domain/status-vocabulary.ts";
import type { IpcMainInvokeEvent } from "electron";
import type { JsonObject } from "@harness-anything/daemon";
import {
  CENTER_SETTINGS_CHANNEL,
  type CenterSwitchInput,
  type CertificateMode,
  type PromoteFromEdgeInput,
} from "../api/center-settings-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

interface Registrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>,
  ) => void;
}

interface DialogPort {
  readonly selectFile: (kind: "certificate" | "private-key") => Promise<string | null>;
}

const modes = new Set<CertificateMode>(["self-signed", "domain", "internal-ca"]);
const REPO_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SWITCHOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SPKI_SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/u;
const RBAC_BACKUP_STATUSES = new Set<RbacBackupStatus>(rbacBackupStatuses);

export interface CenterSettingsIpcPorts {
  readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>;
  readonly fleetRequest: (method: string, params: JsonObject) => Promise<JsonObject>;
  readonly dialog: DialogPort;
  readonly centerSwitch?: (input: CenterSwitchInput) => Promise<JsonObject>;
  readonly promoteFromEdge?: (input: PromoteFromEdgeInput) => Promise<JsonObject>;
  readonly edgeLocalState?: (repoId: string) => Promise<JsonObject>;
}

export function registerCenterSettingsIpc(
  registrar: Registrar,
  trustPolicy: IpcWebContentsTrustPolicy,
  ports: CenterSettingsIpcPorts,
): void {
  registrar.handle(CENTER_SETTINGS_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = asRecord(input);
    const operation = record.operation;
    if (operation === "listener") {
      if (Object.keys(record).length !== 1) throw new Error("Center settings listener takes no fields.");
      return ports.daemonRequest({ operation: "listener" }).then(sanitizeListenerReply);
    }
    if (operation === "fleet-status") {
      if (Object.keys(record).length !== 1) throw new Error("Center fleet status takes no fields.");
      return ports.fleetRequest("daemon.fleet.center.read", { payload: {} });
    }
    if (operation === "center-start") {
      return handleCenterStart(record, ports);
    }
    if (operation === "center-switch") {
      return handleCenterSwitch(record, ports);
    }
    if (operation === "promote-from-edge") {
      return handlePromoteFromEdge(record, ports);
    }
    if (operation === "edge-local-state") {
      return handleEdgeLocalState(record, ports);
    }
    if (operation === "external-address") {
      if (Object.keys(record).length !== 1) throw new Error("Center external-address read takes no fields.");
      return ports.fleetRequest("daemon.fleet.center.external-address.read", { payload: {} });
    }
    if (operation === "external-address-set") {
      if (
        Object.keys(record).length !== 2 ||
        typeof record.externalUrl !== "string" ||
        record.externalUrl.trim() === ""
      )
        throw new Error("Center external-address setting requires an HTTPS URL.");
      return ports.fleetRequest("daemon.fleet.center.external-address.set", {
        payload: { externalUrl: record.externalUrl.trim() },
      });
    }
    if (operation === "select-file") {
      if (Object.keys(record).length !== 2 || (record.kind !== "certificate" && record.kind !== "private-key"))
        throw new Error("Center settings file selection requires a certificate or private-key kind.");
      return ports.dialog.selectFile(record.kind);
    }
    if (operation !== "listener-set") throw new Error("Center settings does not offer that operation.");
    return handleListenerSet(record, ports);
  });
}

function handleCenterStart(record: Record<string, unknown>, ports: CenterSettingsIpcPorts): Promise<JsonObject> {
  const allowed = ["operation", "port", "repoId", "quotaBytes", "bind", "externalUrl"];
  rejectUnexpectedFields(record, allowed, "Center start");
  if (!Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535)
    throw new Error("Center start port must be an integer between 1 and 65535.");
  if (typeof record.repoId !== "string" || !REPO_ID_PATTERN.test(record.repoId))
    throw new Error("Center start requires one authority repository id.");
  if (!isMirrorQuotaValid(record.quotaBytes)) throw new Error("Center start requires a positive integer mirror quota.");
  if (record.bind !== "0.0.0.0" && record.bind !== "127.0.0.1")
    throw new Error("Center start binds either all interfaces or loopback only.");
  if (record.externalUrl !== undefined && (typeof record.externalUrl !== "string" || record.externalUrl === ""))
    throw new Error("Center start external address must be an HTTPS origin.");
  return ports.fleetRequest("daemon.fleet.center.start", {
    payload: {
      port: record.port as number,
      repoId: record.repoId,
      quotaBytes: record.quotaBytes as number,
      bind: record.bind,
      ...(typeof record.externalUrl === "string" ? { externalUrl: record.externalUrl } : {}),
    },
  });
}

function handleCenterSwitch(record: Record<string, unknown>, ports: CenterSettingsIpcPorts): Promise<JsonObject> {
  const allowed = [
    "operation",
    "repoId",
    "targetNodeId",
    "dryRun",
    "abortRollback",
    "switchoverId",
    "reason",
    "targetExternalUrl",
    "targetLoginUrl",
    "targetSpkiSha256",
  ];
  rejectUnexpectedFields(record, allowed, "Center switch");
  if (typeof record.repoId !== "string" || !REPO_ID_PATTERN.test(record.repoId))
    throw new Error("Center switch requires a valid repository id.");
  if (record.abortRollback !== undefined && typeof record.abortRollback !== "boolean")
    throw new Error("Center switch abortRollback must be a boolean.");
  let validated: CenterSwitchInput;
  if (record.abortRollback === true) {
    if (record.dryRun === true) throw new Error("Center switch rollback cannot combine dryRun and abortRollback.");
    if (typeof record.switchoverId !== "string" || !SWITCHOVER_ID_PATTERN.test(record.switchoverId))
      throw new Error("Center switch rollback requires a valid switchoverId.");
    if (typeof record.reason !== "string" || record.reason.trim() === "" || record.reason.length > 500)
      throw new Error("Center switch rollback requires a non-empty reason.");
    validated = {
      repoId: record.repoId,
      abortRollback: true,
      switchoverId: record.switchoverId,
      reason: record.reason.trim(),
    };
  } else {
    if (typeof record.targetNodeId !== "string" || !NODE_ID_PATTERN.test(record.targetNodeId))
      throw new Error("Center switch requires a valid targetNodeId.");
    if (typeof record.dryRun !== "boolean") throw new Error("Center switch requires a boolean dryRun flag.");
    if (
      record.switchoverId !== undefined &&
      (typeof record.switchoverId !== "string" || !SWITCHOVER_ID_PATTERN.test(record.switchoverId))
    )
      throw new Error("Center switch switchoverId has an invalid format.");
    if (
      record.targetExternalUrl !== undefined &&
      (typeof record.targetExternalUrl !== "string" || !isValidHttpsUrl(record.targetExternalUrl))
    )
      throw new Error("Center switch targetExternalUrl must be an HTTPS URL without embedded credentials.");
    if (
      record.targetLoginUrl !== undefined &&
      (typeof record.targetLoginUrl !== "string" || !isValidHttpOrHttpsUrl(record.targetLoginUrl))
    )
      throw new Error("Center switch targetLoginUrl must be an HTTP(S) URL without embedded credentials.");
    if (
      record.targetSpkiSha256 !== undefined &&
      (typeof record.targetSpkiSha256 !== "string" || !SPKI_SHA256_PATTERN.test(record.targetSpkiSha256))
    )
      throw new Error("Center switch targetSpkiSha256 must be a lowercase SHA-256 hex digest.");
    validated = {
      repoId: record.repoId,
      targetNodeId: record.targetNodeId,
      dryRun: record.dryRun,
      ...(typeof record.switchoverId === "string" ? { switchoverId: record.switchoverId } : {}),
      ...(typeof record.targetExternalUrl === "string" ? { targetExternalUrl: record.targetExternalUrl } : {}),
      ...(typeof record.targetLoginUrl === "string" ? { targetLoginUrl: record.targetLoginUrl } : {}),
      ...(typeof record.targetSpkiSha256 === "string" ? { targetSpkiSha256: record.targetSpkiSha256 } : {}),
    };
  }
  if (ports.centerSwitch) return ports.centerSwitch(validated);
  return ports.fleetRequest("daemon.fleet.center.switch", { payload: validated as unknown as JsonObject });
}

function handlePromoteFromEdge(record: Record<string, unknown>, ports: CenterSettingsIpcPorts): Promise<JsonObject> {
  const allowed = ["operation", "repoId", "forceNewEpoch", "confirmPossibleTailLoss", "rbacBackupStatus"];
  rejectUnexpectedFields(record, allowed, "Promote from edge");
  if (typeof record.repoId !== "string" || !REPO_ID_PATTERN.test(record.repoId))
    throw new Error("Promote from edge requires a valid repository id.");
  // Hard double-confirmation gate at the main-process IPC boundary (cannot be bypassed by renderer).
  if (record.forceNewEpoch !== true || record.confirmPossibleTailLoss !== true)
    throw new Error("Break-glass promotion requires both forceNewEpoch=true and confirmPossibleTailLoss=true.");
  if (record.rbacBackupStatus !== undefined && !RBAC_BACKUP_STATUSES.has(record.rbacBackupStatus as RbacBackupStatus))
    throw new Error("Promote from edge rbacBackupStatus must be verified, unavailable, or unknown.");
  const validated: PromoteFromEdgeInput = {
    repoId: record.repoId,
    forceNewEpoch: true,
    confirmPossibleTailLoss: true,
    ...(record.rbacBackupStatus !== undefined ? { rbacBackupStatus: record.rbacBackupStatus as RbacBackupStatus } : {}),
  };
  if (ports.promoteFromEdge) return ports.promoteFromEdge(validated);
  return ports.fleetRequest("daemon.fleet.center.promote-from-edge", { payload: validated as unknown as JsonObject });
}

async function handleEdgeLocalState(
  record: Record<string, unknown>,
  ports: CenterSettingsIpcPorts,
): Promise<JsonObject> {
  const allowed = ["operation", "repoId"];
  rejectUnexpectedFields(record, allowed, "Edge local state");
  if (typeof record.repoId !== "string" || !REPO_ID_PATTERN.test(record.repoId))
    throw new Error("Edge local state requires a valid repository id.");
  if (!ports.edgeLocalState)
    return {
      ok: false,
      code: "edge_local_state_unavailable",
      rejectionExplanation: "Edge local state reader is not configured in this Electron main process.",
    };
  return sanitizeEdgeLocalStateReply(await ports.edgeLocalState(record.repoId), record.repoId);
}

function handleListenerSet(record: Record<string, unknown>, ports: CenterSettingsIpcPorts): Promise<JsonObject> {
  const allowed = [
    "operation",
    "expectedVersion",
    "certificateMode",
    "hostname",
    "listenAddress",
    "port",
    "certificateFile",
    "certificateKeyFile",
  ];
  rejectUnexpectedFields(record, allowed, "Center settings");
  if (typeof record.expectedVersion !== "string" || record.expectedVersion.trim() === "")
    throw new Error("Center settings requires expectedVersion.");
  if (!modes.has(record.certificateMode as CertificateMode)) throw new Error("Choose a supported certificate mode.");
  if (record.certificateMode !== "self-signed") {
    for (const field of ["hostname", "certificateFile", "certificateKeyFile"])
      if (typeof record[field] !== "string" || record[field].trim() === "")
        throw new Error(`Center settings requires ${field}.`);
    if (
      record.port !== undefined &&
      (!Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535)
    )
      throw new Error("Center settings port must be between 1 and 65535.");
  }
  if (
    record.certificateMode === "self-signed" &&
    Object.keys(record).some((key) => ["certificateFile", "certificateKeyFile"].includes(key))
  )
    throw new Error("Self-signed mode manages its own certificate files.");
  return ports
    .daemonRequest({
      operation: "listener-set",
      expectedVersion: record.expectedVersion as string,
      certificateMode: record.certificateMode as string,
      ...(typeof record.hostname === "string" ? { hostname: record.hostname } : {}),
      ...(typeof record.listenAddress === "string" ? { listenAddress: record.listenAddress } : {}),
      ...(typeof record.port === "number" ? { port: record.port } : {}),
      ...(typeof record.certificateFile === "string" ? { certificateFile: record.certificateFile } : {}),
      ...(typeof record.certificateKeyFile === "string" ? { certificateKeyFile: record.certificateKeyFile } : {}),
    })
    .then(sanitizeListenerReply);
}

function sanitizeListenerReply(reply: JsonObject): JsonObject {
  if (reply.listener === null || typeof reply.listener !== "object" || Array.isArray(reply.listener)) return reply;
  const { certificateKeyFile: _privateKey, ...listener } = reply.listener as Record<string, unknown>;
  return { ...reply, listener: listener as JsonObject };
}

/**
 * Explicit allowlist projection for edge-local-state so sensitive fields such as
 * `credential`, tokens, or private key paths can never cross IPC to the renderer.
 */
function sanitizeEdgeLocalStateReply(reply: JsonObject, fallbackRepoId: string): JsonObject {
  if (reply.ok !== true) {
    return {
      ok: false,
      code: typeof reply.code === "string" ? reply.code : "edge_local_state_failed",
      ...(typeof reply.rejectionExplanation === "string" ? { rejectionExplanation: reply.rejectionExplanation } : {}),
    };
  }
  const rawCenter = reply.configuredCenter;
  const configuredCenter =
    rawCenter !== null &&
    typeof rawCenter === "object" &&
    !Array.isArray(rawCenter) &&
    typeof (rawCenter as Record<string, unknown>).host === "string" &&
    typeof (rawCenter as Record<string, unknown>).port === "number"
      ? {
          host: (rawCenter as Record<string, unknown>).host as string,
          port: (rawCenter as Record<string, unknown>).port as number,
        }
      : null;
  return {
    ok: true,
    mode: typeof reply.mode === "string" ? reply.mode : null,
    repoId: typeof reply.repoId === "string" ? reply.repoId : fallbackRepoId,
    nodeId: typeof reply.nodeId === "string" ? reply.nodeId : null,
    configuredCenter,
    localRevision: typeof reply.localRevision === "number" ? reply.localRevision : null,
    localSequence: typeof reply.localSequence === "number" ? reply.localSequence : null,
    writerEpoch: typeof reply.writerEpoch === "number" ? reply.writerEpoch : null,
    syncFailureCode: typeof reply.syncFailureCode === "string" ? reply.syncFailureCode : null,
    canPromote: reply.canPromote === true,
  };
}

function rejectUnexpectedFields(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} does not take ${unknown.join(", ")}.`);
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function isValidHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username === "" && parsed.password === ""
    );
  } catch {
    return false;
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Center settings payload must be an object.");
  return input as Record<string, unknown>;
}
