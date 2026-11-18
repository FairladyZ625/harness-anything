import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { localDaemonTargetKey } from "./client/local-daemon-target.ts";
import { writeFileDurably } from "../../../storage/src/durable-file.ts";
import type { FleetCenterAdmissionRequest } from "./fleet-center-admission.ts";

export function parseFleetCenterExternalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Fleet TLS --external-url must be a complete HTTPS origin, such as https://center.example:7545.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    hostname === "0.0.0.0" ||
    hostname === "::"
  )
    throw new Error(
      "Fleet TLS --external-url must be a complete HTTPS origin without credentials, path, query, or fragment.",
    );
  return url.origin;
}

export type FleetCenterConfig = Omit<Required<FleetCenterAdmissionRequest["payload"]>, "externalUrl"> &
  Pick<FleetCenterAdmissionRequest["payload"], "externalUrl">;

let pendingCertificates: readonly { readonly root: string; readonly paths: readonly string[] }[] = [];

/** Keep paths visible to RBAC pruning from selection through the synchronous center.json write. */
export function retainFleetCenterCertificatePaths(userRoot: string, certPath: string, keyPath: string): () => void {
  const reference = { root: realpathSync(userRoot), paths: [certPath, keyPath] };
  pendingCertificates = [...pendingCertificates, reference];
  return () => {
    pendingCertificates = pendingCertificates.filter((pending) => pending !== reference);
  };
}

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
  if (row.externalUrl !== undefined && typeof row.externalUrl !== "string") fail();
  const externalUrl = typeof row.externalUrl === "string" ? parseFleetCenterExternalUrl(row.externalUrl) : undefined;
  return {
    port: row.port as number,
    bind: row.bind as string,
    repoId: row.repoId as string,
    keyPath: row.keyPath as string,
    certPath: row.certPath as string,
    stateRoot: row.stateRoot as string,
    quotaBytes: row.quotaBytes as number,
    ...(externalUrl ? { externalUrl } : {}),
  };
}

function parseFleetCenterCertificatePaths(
  file: string,
): { readonly ok: true; readonly paths: readonly string[] } | { readonly ok: false; readonly message: string } {
  try {
    const row = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row) || row.schema !== "fleet-center-config/v1") {
      return { ok: true, paths: [] };
    }
    const found: string[] = [];
    if (typeof row.certPath === "string" && path.isAbsolute(row.certPath)) found.push(row.certPath);
    if (typeof row.keyPath === "string" && path.isAbsolute(row.keyPath)) found.push(row.keyPath);
    return { ok: true, paths: found };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function readFleetCenterCertificatePaths(userRoot: string): readonly string[] {
  if (!existsSync(userRoot)) return [];
  const root = realpathSync(userRoot),
    fleetDirectory = path.join(root, "fleet"),
    paths = pendingCertificates.filter((pending) => pending.root === root).flatMap((pending) => pending.paths);
  if (!existsSync(fleetDirectory)) return paths;
  for (const entry of readdirSync(fleetDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(fleetDirectory, entry.name, "center.json");
    if (!existsSync(file)) continue;
    const parsed = parseFleetCenterCertificatePaths(file);
    if (parsed.ok) paths.push(...parsed.paths);
  }
  return paths;
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
