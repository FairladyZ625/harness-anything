// Marks a workspace root as a remote-edge mirror and names the fleet channel
// its write commands must take. Present in `<root>/fleet-edge.json`; the
// machine credential is deliberately NOT duplicated here — the daemon resolves
// it from the center roster at run time via rosterPath + nodeId.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
export interface FleetEdgeConfig { readonly repoId: string; readonly host: string; readonly port: number; readonly caPath: string; readonly servername?: string; readonly nodeId: string; readonly rosterPath?: string; readonly credential?: string; readonly assignmentId: string; readonly viewRoot: string; readonly quotaBytes: number; readonly waitTimeoutMs?: number }
export class FleetEdgeConfigError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "FleetEdgeConfigError"; this.code = code; } }
export function fleetEdgeConfigPath(rootDir: string): string { return path.join(rootDir, "fleet-edge.json"); }
export function readFleetEdgeConfig(rootDir: string): FleetEdgeConfig | null {
  const file = fleetEdgeConfigPath(rootDir);
  if (!existsSync(file)) return null;
  let value: unknown; try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new FleetEdgeConfigError("fleet_edge_config_unreadable", `Fleet edge config at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`); }
  const fail = (detail: string): never => { throw new FleetEdgeConfigError("fleet_edge_config_invalid", `Fleet edge config at ${file} is invalid: ${detail}`); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("the config must be a JSON object");
  const row = value as Record<string, unknown>;
  if (row.schema !== "fleet-edge-config/v1") fail("the top-level schema must be fleet-edge-config/v1");
  const text = (field: string): string | undefined => typeof row[field] === "string" && (row[field] as string).length > 0 ? row[field] as string : undefined;
  for (const field of ["repoId", "host", "caPath", "nodeId", "assignmentId", "viewRoot"]) if (!text(field)) fail(`${field} must be a non-empty string`);
  const port = Number(row.port), quotaBytes = Number(row.quotaBytes);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail("port must be an integer from 0 to 65535");
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) fail("quotaBytes must be a positive integer");
  const waitTimeoutMs = row.waitTimeoutMs === undefined ? undefined : Number(row.waitTimeoutMs);
  if (waitTimeoutMs !== undefined && (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0)) fail("waitTimeoutMs must be a positive integer when present");
  const credential = text("credential"), rosterPath = text("rosterPath");
  if (!credential && !rosterPath) fail("either credential or rosterPath must name the machine credential source");
  return { repoId: text("repoId")!, host: text("host")!, port, caPath: text("caPath")!, ...(text("servername") ? { servername: text("servername") } : {}), nodeId: text("nodeId")!, ...(rosterPath ? { rosterPath } : {}), ...(credential ? { credential } : {}), assignmentId: text("assignmentId")!, viewRoot: text("viewRoot")!, quotaBytes, ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}) };
}
