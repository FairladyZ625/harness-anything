import type { IpcMainInvokeEvent } from "electron";
import type { JsonObject } from "@harness-anything/daemon";
import { CENTER_SETTINGS_CHANNEL, type CertificateMode } from "../api/center-settings-contract.ts";
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

export function registerCenterSettingsIpc(
  registrar: Registrar,
  trustPolicy: IpcWebContentsTrustPolicy,
  ports: { readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>; readonly dialog: DialogPort },
): void {
  registrar.handle(CENTER_SETTINGS_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const record = asRecord(input);
    const operation = record.operation;
    if (operation === "listener") {
      if (Object.keys(record).length !== 1) throw new Error("Center settings listener takes no fields.");
      return ports.daemonRequest({ operation: "listener" }).then(sanitizeListenerReply);
    }
    if (operation === "select-file") {
      if (Object.keys(record).length !== 2 || (record.kind !== "certificate" && record.kind !== "private-key"))
        throw new Error("Center settings file selection requires a certificate or private-key kind.");
      return ports.dialog.selectFile(record.kind);
    }
    if (operation !== "listener-set") throw new Error("Center settings does not offer that operation.");
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
    const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new Error(`Center settings does not take ${unknown.join(", ")}.`);
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
  });
}

function sanitizeListenerReply(reply: JsonObject): JsonObject {
  if (reply.listener === null || typeof reply.listener !== "object" || Array.isArray(reply.listener)) return reply;
  const { certificateKeyFile: _privateKey, ...listener } = reply.listener as Record<string, unknown>;
  return { ...reply, listener: listener as JsonObject };
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Center settings payload must be an object.");
  return input as Record<string, unknown>;
}
