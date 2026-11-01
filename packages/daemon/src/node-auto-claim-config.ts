import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileDurably } from "@harness-anything/storage";

export interface NodeAutoClaimPolicy {
  readonly schema: "node-auto-claim/v1";
  readonly enabled: boolean;
  readonly allowedSources: {
    readonly personIds: readonly string[];
    readonly teamIds: readonly string[];
  };
  readonly allowedAgentIds: readonly string[];
  readonly maxConcurrent: number;
}

export type NodeAutoClaimDiagnostic = "missing" | "invalid_json" | "invalid_policy" | "valid";

export interface NodeAutoClaimPersistedDiagnostic {
  readonly repoId: string;
  readonly taskId: string | null;
  readonly reason: string;
  readonly observedAt: string;
  readonly assignedByPersonId?: string;
}

export const DEFAULT_NODE_AUTO_CLAIM_POLICY: NodeAutoClaimPolicy = Object.freeze({
  schema: "node-auto-claim/v1",
  enabled: false,
  allowedSources: { personIds: [], teamIds: [] },
  allowedAgentIds: [],
  maxConcurrent: 1,
});

export function nodeAutoClaimConfigPath(userRoot: string): string {
  return path.join(userRoot, "node-auto-claim.json");
}

export function nodeAutoClaimDiagnosticsPath(userRoot: string): string {
  return path.join(userRoot, "node-auto-claim-diagnostics.json");
}

export function readNodeAutoClaimDiagnostics(userRoot: string): readonly NodeAutoClaimPersistedDiagnostic[] {
  const file = nodeAutoClaimDiagnosticsPath(userRoot);
  if (!existsSync(file)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row): row is NodeAutoClaimPersistedDiagnostic =>
        row !== null &&
        typeof row === "object" &&
        typeof row.repoId === "string" &&
        (typeof row.taskId === "string" || row.taskId === null) &&
        typeof row.reason === "string" &&
        typeof row.observedAt === "string" &&
        (row.assignedByPersonId === undefined || typeof row.assignedByPersonId === "string"),
    );
  } catch {
    return [];
  }
}

export function recordNodeAutoClaimDiagnostic(userRoot: string, row: NodeAutoClaimPersistedDiagnostic): void {
  const rows = [...readNodeAutoClaimDiagnostics(userRoot), row].slice(-200);
  writeFileDurably(nodeAutoClaimDiagnosticsPath(userRoot), `${JSON.stringify(rows, null, 2)}\n`, 0o600);
}

export function readNodeAutoClaimPolicy(userRoot: string): {
  readonly policy: NodeAutoClaimPolicy;
  readonly diagnostic: NodeAutoClaimDiagnostic;
  readonly error?: string;
} {
  const file = nodeAutoClaimConfigPath(userRoot);
  if (!existsSync(file)) return { policy: DEFAULT_NODE_AUTO_CLAIM_POLICY, diagnostic: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      policy: DEFAULT_NODE_AUTO_CLAIM_POLICY,
      diagnostic: "invalid_json",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return { policy: parseNodeAutoClaimPolicy(value), diagnostic: "valid" };
  } catch (error) {
    return {
      policy: DEFAULT_NODE_AUTO_CLAIM_POLICY,
      diagnostic: "invalid_policy",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeNodeAutoClaimPolicy(userRoot: string, value: NodeAutoClaimPolicy): void {
  const policy = parseNodeAutoClaimPolicy(value);
  writeFileDurably(nodeAutoClaimConfigPath(userRoot), `${JSON.stringify(policy, null, 2)}\n`, 0o600);
}

export function parseNodeAutoClaimPolicy(value: unknown): NodeAutoClaimPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("node auto-claim policy must be an object");
  const row = value as Record<string, unknown>;
  if (row.schema !== "node-auto-claim/v1") throw new Error("schema must be node-auto-claim/v1");
  if (typeof row.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (row.allowedSources === null || typeof row.allowedSources !== "object" || Array.isArray(row.allowedSources))
    throw new Error("allowedSources must be an object");
  const sources = row.allowedSources as Record<string, unknown>,
    personIds = identifierList(sources.personIds, "allowedSources.personIds"),
    teamIds = identifierList(sources.teamIds, "allowedSources.teamIds"),
    allowedAgentIds = identifierList(row.allowedAgentIds, "allowedAgentIds"),
    maxConcurrent = row.maxConcurrent;
  if (!Number.isSafeInteger(maxConcurrent) || Number(maxConcurrent) < 1 || Number(maxConcurrent) > 64)
    throw new Error("maxConcurrent must be an integer from 1 to 64");
  const allowed = ["schema", "enabled", "allowedSources", "allowedAgentIds", "maxConcurrent"];
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error("unknown policy field");
  if (Object.keys(sources).some((key) => !["personIds", "teamIds"].includes(key)))
    throw new Error("unknown allowedSources field");
  return {
    schema: "node-auto-claim/v1",
    enabled: row.enabled,
    allowedSources: { personIds, teamIds },
    allowedAgentIds,
    maxConcurrent: Number(maxConcurrent),
  };
}

function identifierList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === ""))
    throw new Error(`${field} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))].sort();
}
