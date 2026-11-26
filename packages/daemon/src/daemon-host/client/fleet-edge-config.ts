// Marks a registered repository on an edge node as a remote-edge mirror and names the fleet
// channel its write commands must take. Stored outside the business repository under
// `<userRoot>/fleet/edge/<repoId>/fleet-edge.json`; it carries the machine credential the center
// issued when the node was registered. The repository selects the canonical center namespace.
// A successful `ha daemon fleet edge sync` writes it; the resident replica stream reads it.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { readDaemonRegistry } from "@harness-anything/kernel";
import {
  normalizeFleetEdgeTrustAnchors,
  type FleetEdgeTrustAnchors,
} from "@harness-anything/kernel/internal/domain/center-switchover.ts";
// The durable-write helper is imported from its module, not the storage barrel: this file is
// loaded by the thin CLI on every task read/write command, and the barrel pulls the whole
// storage graph (pglite, pg, projections) into that process for one synchronous write.
import { removeFileDurably, writeFileDurably } from "../../../../storage/src/durable-file.ts";
export type { FleetEdgeTrustAnchors };
export interface FleetEdgeConfig {
  readonly repoId: string;
  readonly host: string;
  readonly port: number;
  readonly caPath: string;
  readonly servername?: string;
  readonly spkiSha256?: string;
  readonly spkiPinOnly?: true;
  readonly trustAnchors?: FleetEdgeTrustAnchors;
  readonly loginUrl?: string;
  readonly loginRealm?: string;
  readonly loginServername?: string;
  readonly loginBrowserUrl?: string;
  readonly loginCertificate?: string;
  readonly nodeId: string;
  readonly credential: string;
  readonly writerEpoch?: number;
  readonly resumeOnly?: true;
  readonly viewRoot: string;
  readonly quotaBytes: number;
  readonly waitTimeoutMs?: number;
  readonly maxAgeMs?: number;
  readonly maxLagRevisions?: number;
}
export class FleetEdgeConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FleetEdgeConfigError";
    this.code = code;
  }
}
const SAFE_REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function fleetEdgeConfigDir(userRoot: string, repoId: string): string {
  if (!SAFE_REPO_ID.test(repoId))
    throw new FleetEdgeConfigError("fleet_edge_config_invalid", `Invalid fleet edge repository id: ${repoId}.`);
  return path.join(path.resolve(userRoot), "fleet", "edge", repoId);
}
export function fleetEdgeConfigPath(userRoot: string, repoId: string): string {
  return path.join(fleetEdgeConfigDir(userRoot, repoId), "fleet-edge.json");
}
export function fleetEdgeCaPath(userRoot: string, repoId: string): string {
  return path.join(fleetEdgeConfigDir(userRoot, repoId), "fleet-center-ca.pem");
}
export interface FleetEdgePendingRepoint {
  readonly repoId: string;
  readonly nodeId: string;
  readonly host: string;
  readonly port: number;
  readonly spkiSha256: string;
  readonly previousWriterEpoch: number;
  readonly targetWriterEpoch: number;
  readonly ledgerGeneration: number;
}
export function fleetEdgePendingRepointPath(userRoot: string, repoId: string): string {
  return path.join(fleetEdgeConfigDir(userRoot, repoId), "repoint-pending.json");
}
export interface FleetEdgeWorkspaceResidue {
  readonly code: "fleet_edge_config_workspace_residue";
  readonly message: string;
}

export function fleetEdgeWorkspaceResidue(
  userRoot: string,
  repoId: string,
  rootDir: string,
): FleetEdgeWorkspaceResidue | null {
  const destination = fleetEdgeConfigPath(userRoot, repoId);
  if (existsSync(destination)) return null;
  const source = path.join(rootDir, "fleet-edge.json");
  if (lstatSync(source, { throwIfNoEntry: false }) === undefined) return null;
  const sourceCa = path.join(rootDir, "fleet-center-ca.pem"),
    destinationCa = fleetEdgeCaPath(userRoot, repoId);
  return {
    code: "fleet_edge_config_workspace_residue",
    message: `Move ${JSON.stringify(source)} to ${JSON.stringify(destination)}. If present, move ${JSON.stringify(sourceCa)} to ${JSON.stringify(destinationCa)} and set caPath in the moved config to that absolute CA path. Then rerun ha daemon fleet edge sync.`,
  };
}

export function locateFleetEdgeConfig(userRoot: string, repoId: string, rootDir?: string): string | null {
  const destination = fleetEdgeConfigPath(userRoot, repoId);
  if (existsSync(destination)) return destination;
  if (rootDir === undefined) return null;
  const residue = fleetEdgeWorkspaceResidue(userRoot, repoId, rootDir);
  if (residue !== null) throw new FleetEdgeConfigError(residue.code, residue.message);
  return null;
}

export function readFleetEdgeConfig(userRoot: string, repoId: string, remoteEdgeRoot?: string): FleetEdgeConfig | null {
  const file = locateFleetEdgeConfig(userRoot, repoId, remoteEdgeRoot);
  if (!file) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new FleetEdgeConfigError(
      "fleet_edge_config_unreadable",
      `Fleet edge config at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const fail = (detail: string): never => {
    throw new FleetEdgeConfigError("fleet_edge_config_invalid", `Fleet edge config at ${file} is invalid: ${detail}`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("the config must be a JSON object");
  const row = value as Record<string, unknown>;
  if (row.schema !== "fleet-edge-config/v1") fail("the top-level schema must be fleet-edge-config/v1");
  const text = (field: string): string | undefined =>
    typeof row[field] === "string" && (row[field] as string).length > 0 ? (row[field] as string) : undefined;
  for (const field of ["repoId", "host", "caPath", "nodeId", "credential", "viewRoot"])
    if (!text(field)) fail(`${field} must be a non-empty string`);
  if (Object.hasOwn(row, "assignmentId") || Object.hasOwn(row, "rosterPath"))
    fail("Static fleet assignments are retired.");
  if (row.spkiSha256 !== undefined && (typeof row.spkiSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.spkiSha256)))
    fail("spkiSha256 must be a lowercase SHA-256 digest when present");
  if (row.spkiPinOnly !== undefined && row.spkiPinOnly !== true) fail("spkiPinOnly must be true when present");
  if (row.spkiPinOnly === true && !text("spkiSha256")) fail("spkiPinOnly requires spkiSha256");
  const port = Number(row.port),
    quotaBytes = Number(row.quotaBytes);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail("port must be an integer from 0 to 65535");
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) fail("quotaBytes must be a positive integer");
  const waitTimeoutMs = row.waitTimeoutMs === undefined ? undefined : Number(row.waitTimeoutMs);
  const writerEpoch = row.writerEpoch === undefined ? undefined : Number(row.writerEpoch);
  if (writerEpoch !== undefined && (!Number.isSafeInteger(writerEpoch) || writerEpoch < 0))
    fail("writerEpoch must be a non-negative integer when present");
  if (row.resumeOnly !== undefined && row.resumeOnly !== true) fail("resumeOnly must be true when present");
  if (waitTimeoutMs !== undefined && (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0))
    fail("waitTimeoutMs must be a positive integer when present");
  const maxAgeMs = row.maxAgeMs === undefined ? undefined : Number(row.maxAgeMs),
    maxLagRevisions = row.maxLagRevisions === undefined ? undefined : Number(row.maxLagRevisions);
  if (maxAgeMs !== undefined && (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0))
    fail("maxAgeMs must be a non-negative integer when present");
  if (maxLagRevisions !== undefined && (!Number.isSafeInteger(maxLagRevisions) || maxLagRevisions < 0))
    fail("maxLagRevisions must be a non-negative integer when present");
  let trustAnchors: FleetEdgeTrustAnchors | undefined;
  if (row.trustAnchors !== undefined) {
    if (row.trustAnchors === null || typeof row.trustAnchors !== "object" || Array.isArray(row.trustAnchors))
      fail("trustAnchors must be a JSON object when present");
    const rawAnchors = row.trustAnchors as Record<string, unknown>;
    if (Object.keys(rawAnchors).some((key) => key !== "caPaths" && key !== "spkiSha256"))
      fail("trustAnchors may only contain caPaths and spkiSha256");
    const parsedAnchors = normalizeFleetEdgeTrustAnchors(rawAnchors as FleetEdgeTrustAnchors);
    if (!parsedAnchors.ok) return fail(parsedAnchors.detail);
    trustAnchors = parsedAnchors.value;
  }
  return {
    repoId: text("repoId")!,
    host: text("host")!,
    port,
    caPath: text("caPath")!,
    ...(text("servername") ? { servername: text("servername") } : {}),
    ...(text("spkiSha256") ? { spkiSha256: text("spkiSha256") } : {}),
    ...(row.spkiPinOnly === true ? { spkiPinOnly: true } : {}),
    ...(trustAnchors ? { trustAnchors } : {}),
    ...(text("loginUrl") ? { loginUrl: text("loginUrl") } : {}),
    ...(text("loginRealm") ? { loginRealm: text("loginRealm") } : {}),
    ...(text("loginServername") ? { loginServername: text("loginServername") } : {}),
    ...(text("loginBrowserUrl") ? { loginBrowserUrl: text("loginBrowserUrl") } : {}),
    ...(text("loginCertificate") ? { loginCertificate: text("loginCertificate") } : {}),
    nodeId: text("nodeId")!,
    credential: text("credential")!,
    ...(writerEpoch === undefined ? {} : { writerEpoch }),
    ...(row.resumeOnly === true ? { resumeOnly: true } : {}),
    viewRoot: text("viewRoot")!,
    quotaBytes,
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
    ...(maxLagRevisions !== undefined ? { maxLagRevisions } : {}),
  };
}
/** Writes the config a successful edge sync admitted; the file carries the node's machine credential. */
export function writeFleetEdgeConfig(userRoot: string, repoId: string, config: FleetEdgeConfig): void {
  writeFileDurably(
    fleetEdgeConfigPath(userRoot, repoId),
    `${JSON.stringify({ schema: "fleet-edge-config/v1", ...config }, null, 2)}\n`,
    0o600,
  );
}
export function removeFleetEdgeConfig(userRoot: string, repoId: string): void {
  for (const file of [
    fleetEdgeConfigPath(userRoot, repoId),
    fleetEdgeCaPath(userRoot, repoId),
    fleetEdgePendingRepointPath(userRoot, repoId),
  ])
    if (existsSync(file)) removeFileDurably(file);
}
export function readFleetEdgePendingRepoint(userRoot: string, repoId: string): FleetEdgePendingRepoint | null {
  const file = fleetEdgePendingRepointPath(userRoot, repoId);
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new FleetEdgeConfigError(
      "fleet_edge_config_unreadable",
      `Pending repoint journal at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const fail = (detail: string): never => {
    throw new FleetEdgeConfigError(
      "fleet_edge_config_invalid",
      `Pending repoint journal at ${file} is invalid: ${detail}`,
    );
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("must be a JSON object");
  const row = value as Record<string, unknown>,
    text = (field: string): string | undefined =>
      typeof row[field] === "string" && (row[field] as string).length > 0 ? (row[field] as string) : undefined;
  if (row.schema !== "fleet-edge-repoint-pending/v1") fail("schema must be fleet-edge-repoint-pending/v1");
  for (const field of ["repoId", "nodeId", "host"]) if (!text(field)) fail(`${field} must be a non-empty string`);
  const port = Number(row.port),
    previousWriterEpoch = Number(row.previousWriterEpoch),
    targetWriterEpoch = Number(row.targetWriterEpoch),
    ledgerGeneration = Number(row.ledgerGeneration);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail("port must be an integer from 0 to 65535");
  if (typeof row.spkiSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.spkiSha256))
    fail("spkiSha256 must be a lowercase SHA-256 digest");
  if (!Number.isSafeInteger(previousWriterEpoch) || previousWriterEpoch < 1)
    fail("previousWriterEpoch must be a positive integer");
  if (!Number.isSafeInteger(targetWriterEpoch) || targetWriterEpoch <= previousWriterEpoch)
    fail("targetWriterEpoch must be greater than previousWriterEpoch");
  if (!Number.isSafeInteger(ledgerGeneration) || ledgerGeneration < 0)
    fail("ledgerGeneration must be a non-negative integer");
  return {
    repoId: text("repoId")!,
    nodeId: text("nodeId")!,
    host: text("host")!,
    port,
    spkiSha256: row.spkiSha256 as string,
    previousWriterEpoch,
    targetWriterEpoch,
    ledgerGeneration,
  };
}
export function writeFleetEdgePendingRepoint(userRoot: string, repoId: string, pending: FleetEdgePendingRepoint): void {
  writeFileDurably(
    fleetEdgePendingRepointPath(userRoot, repoId),
    `${JSON.stringify({ schema: "fleet-edge-repoint-pending/v1", ...pending }, null, 2)}\n`,
    0o600,
  );
}
export function removeFleetEdgePendingRepoint(userRoot: string, repoId: string): void {
  const file = fleetEdgePendingRepointPath(userRoot, repoId);
  if (existsSync(file)) removeFileDurably(file);
}
export function writeFleetEdgePinnedCaCert(
  userRoot: string,
  repoId: string,
  spkiSha256: string,
  chainPem: string,
): string {
  const filePath = path.join(fleetEdgeConfigDir(userRoot, repoId), `pinned-center-${spkiSha256.slice(0, 16)}.pem`);
  writeFileDurably(filePath, chainPem, 0o600);
  return filePath;
}
export function removeFleetEdgePinnedCaCert(filePath: string): void {
  if (existsSync(filePath)) removeFileDurably(filePath);
}
function canonicalComparePath(target: string): string {
  const resolved = path.resolve(target),
    canonical = existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
export function resolveFleetEdgeRepoIdForRoot(userRoot: string, rootDir: string): string | null {
  const target = canonicalComparePath(rootDir),
    matches = readDaemonRegistry({ userRoot }).repos.filter(
      (repo) =>
        repo.mode === "remote-edge" &&
        repo.canonicalRoot !== null &&
        canonicalComparePath(repo.canonicalRoot) === target,
    ),
    preferred = matches.find((repo) => repo.state === "enabled") ?? matches[0];
  return preferred?.repoId ?? null;
}
export function readFleetEdgeConfigForRoot(userRoot: string, rootDir: string): FleetEdgeConfig | null {
  const repoId = resolveFleetEdgeRepoIdForRoot(userRoot, rootDir);
  return repoId === null ? null : readFleetEdgeConfig(userRoot, repoId, rootDir);
}
export function hasAnyFleetEdgeConfig(userRoot: string): boolean {
  const edgeRoot = path.join(path.resolve(userRoot), "fleet", "edge");
  return (
    existsSync(edgeRoot) &&
    readdirSync(edgeRoot, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        existsSync(path.join(edgeRoot, entry.name, "fleet-edge.json")),
    )
  );
}
