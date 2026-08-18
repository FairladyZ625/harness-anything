// Edge-side product write path: routes one `ha task ...` write command through
// the fleet TLS channel, attaches to the center's wait queue for as long as the
// caller is willing to wait, reconnects with full-jitter exponential backoff
// when the transport drops mid-wait (same opId, so the center coalesces), and
// pulls the replica view after an applied outcome so the center effect lands
// in the local mirror.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { FleetRemoteError, runFleetReplicaPullClient, runFleetTaskCommandClient } from "./fleet/edge.ts";
import { readFleetRosterFile } from "./fleet-center-admission.ts";
import { fleetLeaseTimers } from "./fleet/lease-broker.ts";
import type { FleetTaskAction } from "./fleet/contract.ts";

const BACKOFF_MIN_MS = 250, BACKOFF_MAX_MS = 30_000;
export interface FleetEdgeTaskRequest { readonly payload: { readonly host: string; readonly port: number; readonly caPath: string; readonly servername?: string; readonly nodeId: string; readonly credential?: string; readonly rosterPath?: string; readonly assignmentId: string; readonly repoId: string; readonly viewRoot: string; readonly quotaBytes: number; readonly waitTimeoutMs?: number; readonly action: FleetTaskAction } }
export class FleetEdgeTaskError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "FleetEdgeTaskError"; this.code = code; } }

export async function runFleetEdgeTask(input: FleetEdgeTaskRequest): Promise<Record<string, unknown>> {
  const payload = input.payload, action = payload.action, timers = fleetLeaseTimers();
  const credential = payload.credential ?? nodeCredential(payload.nodeId, payload.rosterPath);
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  const waitMs = payload.waitTimeoutMs !== undefined && Number.isSafeInteger(payload.waitTimeoutMs) && payload.waitTimeoutMs > 0 ? payload.waitTimeoutMs : timers.maxWaitMs;
  const opId = randomUUID(), peer = { hostname: payload.host, port: payload.port, ca: readFileSync(payload.caPath, "utf8"), servername: payload.servername, nodeId: payload.nodeId, credential, assignmentId: payload.assignmentId };
  const deadline = Date.now() + waitMs + 30_000;
  let result: Awaited<ReturnType<typeof runFleetTaskCommandClient>> | null = null, attempt = 0;
  while (result === null) {
    const remaining = Math.max(1, deadline - Date.now());
    try { result = await runFleetTaskCommandClient({ ...peer, opId, repoId: payload.repoId, taskId, action, waitMs, timeoutMs: remaining + 10_000 }); }
    catch (error) { if (Date.now() >= deadline || !retryable(error)) throw error; consumeKnownError(error); await sleep(backoff(attempt++)); }
  }
  const applied = result.outcome === "applied";
  let mirror: Record<string, unknown> | null = null;
  if (applied) { try { const pulled = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs: 60_000 }); mirror = { outcome: "applied", cut: pulled.current.cut }; } catch (error) { consumeKnownError(error); mirror = { outcome: "pull_failed", nextAction: "The center effect stands; rerun ha daemon fleet edge sync to project it into the local mirror.", error: error instanceof Error ? error.message : String(error) }; } }
  const receipt = result.receipt ?? { outcome: result.outcome, code: result.code };
  const ok = applied;
  return { schema: "command-receipt/v2", ok, command: action.kind, outcome: result.outcome, opId: result.opId !== "" ? result.opId : `fleet:${opId}`, revision: result.revision ?? null, ...(ok ? {} : { error: { code: result.code ?? "fleet_task_rejected", hint: typeof receipt.nextAction === "string" ? receipt.nextAction : "Inspect the fleet task receipt." } }), ...(receipt as Record<string, unknown>), fleet: { origin: "fleet-edge", nodeId: payload.nodeId, assignmentId: payload.assignmentId, commandOpId: opId, waitOutcome: result.outcome, lease: result.lease }, ...(mirror ? { mirror } : {}), ...(result.queuePosition !== null ? { queuePosition: result.queuePosition } : {}) } as Record<string, unknown>;
}
function nodeCredential(nodeId: string, rosterPath?: string): string { if (!rosterPath) throw new FleetEdgeTaskError("credential_required", "Fleet edge task routing needs --credential or --roster-path in the edge config."); const node = readFleetRosterFile(rosterPath).nodes.find((entry) => entry.nodeId === nodeId); if (!node) throw new FleetEdgeTaskError("node_unknown", `Node ${nodeId} is not declared in the fleet roster at ${rosterPath}.`); return node.credential; }
function retryable(error: unknown): boolean { if (error instanceof FleetRemoteError) return error.retryable; if (error instanceof FleetEdgeTaskError) return false; const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : null; if (code && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ERR_TLS"].some((value) => code.includes(value))) return true; return error instanceof Error && /Fleet response timeout|session ready expected|task result expected|daemon closed/u.test(error.message); }
function backoff(attempt: number): number { const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt); return Math.floor(Math.random() * ceiling) + 1; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }); }
