import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { localDaemonTargetKey } from "./client/local-daemon-target.ts";
import { writeFileDurably } from "./durable-file.ts";
import type { FleetCenterAdmissionRequest } from "./fleet-center-admission.ts";

export type FleetCenterConfig = Required<FleetCenterAdmissionRequest["payload"]>;

export function fleetCenterConfigPath(userRoot: string, daemonId: string): string {
  return path.join(userRoot, "fleet", localDaemonTargetKey(userRoot, daemonId), "center.json");
}

export function readFleetCenterConfig(userRoot: string, daemonId: string): FleetCenterConfig | null {
  const file = fleetCenterConfigPath(userRoot, daemonId);
  if (!existsSync(file)) return null;
  const body = readFileSync(file, "utf8");
  const row = JSON.parse(body) as Record<string, unknown>;
  const fail = (): never => {
    throw new Error(`Fleet center config at ${file} is invalid; correct its saved listener references.`);
  };
  if (!row || typeof row !== "object" || Array.isArray(row) || row.schema !== "fleet-center-config/v1") fail();
  for (const field of ["bind", "repoId", "keyPath", "certPath", "stateRoot"])
    if (typeof row[field] !== "string" || (row[field] as string).length === 0) fail();
  for (const field of ["keyPath", "certPath", "stateRoot"]) if (!path.isAbsolute(row[field] as string)) fail();
  if (!Number.isSafeInteger(row.port) || Number(row.port) < 1 || Number(row.port) > 65535) fail();
  if (!Number.isSafeInteger(row.quotaBytes) || Number(row.quotaBytes) <= 0) fail();
  return {
    port: row.port as number,
    bind: row.bind as string,
    repoId: row.repoId as string,
    keyPath: row.keyPath as string,
    certPath: row.certPath as string,
    stateRoot: row.stateRoot as string,
    quotaBytes: row.quotaBytes as number,
  };
}

export function saveFleetCenterConfig(userRoot: string, daemonId: string, config: FleetCenterConfig): void {
  writeFileDurably(
    fleetCenterConfigPath(userRoot, daemonId),
    JSON.stringify({
      schema: "fleet-center-config/v1",
      ...config,
    }) + "\n",
    0o600,
  );
}
