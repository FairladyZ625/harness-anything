// Edge-side product write path: routes one `ha task ...` write command through
// the fleet TLS channel, attaches to the center's wait queue for as long as the
// caller is willing to wait, reconnects with full-jitter exponential backoff
// when the transport drops mid-wait (same opId, so the center coalesces), and
// pulls the replica view after an applied outcome so the center effect lands
// in the local mirror.
//
// W3-C class-A sync (design-v2 §3): when the command's task package has local
// mirror-worktree changes, they ride the same command — uploaded as claims and
// carried with the mirror base cut — so the center validates holder, document
// base, and lifecycle transition as one serial command. A conflict rejects the
// whole command and stages base/local/center into .harness/conflicts; an
// applied outcome auto-pulls and reports the dual-axis mirror outcome.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyTextualArtifactPath, consumeKnownError, DOC_POLICY_ID } from "../../kernel/src/index.ts";
import { FleetRemoteError, runFleetReplicaPullClient, runFleetTaskCommandClient, runFleetUploadClient } from "./fleet/edge.ts";
import type { FleetDescriptor } from "./fleet/contract.ts";
import { readFleetRosterFile } from "./fleet-center-admission.ts";
import { fleetLeaseTimers } from "./lease-broker.ts";
import type { FleetTaskAction } from "./fleet/contract.ts";
import { applyFleetMirrorCut, cacheFleetMirrorDirtyBases, locateFleetMirrorView, readFleetUnresolvedConflicts, scanFleetMirrorWorktree, withFleetMirrorLock, type FleetMirrorView, type FleetStagedConflict } from "./fleet-edge-mirror.ts";

const BACKOFF_MIN_MS = 250, BACKOFF_MAX_MS = 30_000;
export interface FleetEdgeTaskRequest { readonly payload: { readonly host: string; readonly port: number; readonly caPath: string; readonly servername?: string; readonly nodeId: string; readonly credential?: string; readonly rosterPath?: string; readonly assignmentId: string; readonly repoId: string; readonly viewRoot: string; readonly quotaBytes: number; readonly workspaceRoot?: string; readonly waitTimeoutMs?: number; readonly action: FleetTaskAction } }
export class FleetEdgeTaskError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "FleetEdgeTaskError"; this.code = code; } }

// Shared machine-credential resolution for every edge product round: the
// credential is never duplicated into fleet-edge.json; it is resolved from the
// center roster at run time.
export function fleetEdgeCredential(nodeId: string, credential: string | undefined, rosterPath: string | undefined): string { if (credential) return credential; if (!rosterPath) throw new FleetEdgeTaskError("credential_required", "Fleet edge routing needs --credential or --roster-path in the edge config."); const node = readFleetRosterFile(rosterPath).nodes.find((entry) => entry.nodeId === nodeId); if (!node) throw new FleetEdgeTaskError("node_unknown", `Node ${nodeId} is not declared in the fleet roster at ${rosterPath}.`); return node.credential; }
export function fleetEdgeScopePaths(assignmentId: string, rosterPath: string | undefined): readonly string[] | null { if (!rosterPath) return null; return readFleetRosterFile(rosterPath).assignments.find((entry) => entry.assignmentId === assignmentId)?.paths ?? null; }
// Conservative task-path predicate for the unresolved-conflict gate. It
// deliberately has no ULID alphabet heuristic, so lowercase generated ids
// and plain ids are both covered. Automatic carry resolves the exact package
// below from its canonical INDEX instead of trusting this prefix predicate.
export function fleetDocPathInTaskPackage(value: string, taskId: string): boolean { const match = /^tasks\/([^/]+)\//u.exec(value); if (!match) return false; const folder = match[1]!; return folder === taskId || folder.startsWith(`${taskId}-`); }

// Folder names alone are only a candidate because legal task ids can contain
// hyphens: `task-direct-other` may be either a slugged `task-direct` package
// or a distinct task id. The canonical package INDEX owns that distinction.
// Returning null on absent/ambiguous metadata fails closed for automatic
// carry, while the center remains the final task/lease authority.
function fleetExactTaskPackagePath(view: FleetMirrorView, taskId: string): string | null {
  const paths = new Set<string>();
  for (const logical of view.entries.keys()) {
    const match = /^(tasks\/[^/]+)\/INDEX\.md$/u.exec(logical);
    if (!match) continue;
    try {
      const body = readFileSync(path.join(view.worktreeRoot, ...logical.split("/")), "utf8");
      if (body.split(/\r?\n/u).some((line) => line === `task_id: ${taskId}` || line === `taskId: ${taskId}`)) paths.add(match[1]!);
    } catch (error) { consumeKnownError(error); }
  }
  return paths.size === 1 ? [...paths][0]! : null;
}

export async function runFleetEdgeTask(input: FleetEdgeTaskRequest): Promise<Record<string, unknown>> {
  const payload = input.payload, action = payload.action, timers = fleetLeaseTimers();
  const credential = fleetEdgeCredential(payload.nodeId, payload.credential, payload.rosterPath);
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  const waitMs = payload.waitTimeoutMs !== undefined && Number.isSafeInteger(payload.waitTimeoutMs) && payload.waitTimeoutMs > 0 ? payload.waitTimeoutMs : timers.maxWaitMs;
  const opId = randomUUID(), peer = { hostname: payload.host, port: payload.port, ca: readFileSync(payload.caPath, "utf8"), servername: payload.servername, nodeId: payload.nodeId, credential, assignmentId: payload.assignmentId };
  const workspaceRoot = payload.workspaceRoot ?? null;
  // One edge/view has a single materialized worktree. Hold its round fence
  // across gate check, candidate scan/upload, center command, pull, and local
  // materialization so an A round cannot interleave with B sync (or another
  // A round) between those state-machine edges.
  return withFleetMirrorLock(payload.viewRoot, payload.repoId, async () => {
  // The unresolved-conflict gate (design §4): while this task's package has a
  // staged, unhandled divergence, its transitions stay blocked — the edge
  // refuses before any upload or center round-trip.
  if (workspaceRoot !== null && taskId !== null && action.kind !== "task-create") {
    const view = locateFleetMirrorView(payload.viewRoot, payload.repoId), exactPackage = view === null ? null : fleetExactTaskPackagePath(view, taskId), belongs = (conflictPath: string): boolean => exactPackage === null ? fleetDocPathInTaskPackage(conflictPath, taskId) : conflictPath.startsWith(`${exactPackage}/`);
    const open = readFleetUnresolvedConflicts(workspaceRoot, payload.repoId).flatMap((record) => record.paths.map((row) => row.path)).filter(belongs);
    if (open.length > 0) return { schema: "command-receipt/v2", ok: false, command: action.kind, outcome: "op_rejected", opId: `conflict-open:${taskId}`, canonicalOutcome: "op_rejected", mirrorOutcome: "conflict_open", code: "conflict_open", taskId, error: { code: "conflict_open", hint: `An unresolved staged conflict covers ${[...new Set(open)].sort().join(", ")}; exit explicitly with ha doc conflict resolve|discard-local|overwrite-center before rerunning this task's commands.` } } as Record<string, unknown>;
  }
  const bundle = await attachTaskDocs();
  const deadline = Date.now() + waitMs + 30_000 + (bundle === null ? 0 : 60_000);
  let result: Awaited<ReturnType<typeof runFleetTaskCommandClient>> | null = null, attempt = 0;
  while (result === null) {
    const remaining = Math.max(1, deadline - Date.now());
    try { const next = await runFleetTaskCommandClient({ ...peer, opId, repoId: payload.repoId, taskId, action, waitMs, timeoutMs: remaining + 10_000, docChanges: bundle === null ? undefined : bundle.docChanges, mirrorBaseCut: bundle === null ? undefined : bundle.mirrorBaseCut }); if (Date.now() < deadline && transientResult(next)) { await sleep(backoff(attempt++)); continue; } result = next; }
    catch (error) { if (Date.now() >= deadline || !retryable(error)) throw error; consumeKnownError(error); await sleep(backoff(attempt++)); }
  }
  const applied = result.outcome === "applied";
  const conflictCode = result.outcome === "op_rejected" && result.code !== null && FLEET_DOC_CONFLICT_CODES.includes(result.code) ? result.code : null;
  let mirror: Record<string, unknown> | null = null;
  const staged: FleetStagedConflict[] = [];
  // Any center effect (applied) and any content conflict both end in a pull:
  // applied commands must land in the mirror, and a rejected bundle needs the
  // center bytes staged beside the local ones for the explicit exits.
  if (applied || conflictCode !== null) {
    try { const pulled = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs: 60_000 });
      const settle = workspaceRoot === null ? null : applyFleetMirrorCut(payload.viewRoot, payload.repoId, workspaceRoot, applied ? "pull" : "command-rejected", { taskId, executionId: result.lease?.executionId ?? null, kind: "task-docs", ...(conflictCode !== null ? { code: conflictCode } : {}) });
      staged.push(...(settle?.conflicts ?? []));
      mirror = { outcome: settle !== null && settle.outcome === "pull_blocked" ? "pull_blocked" : "applied", cut: pulled.current.cut, ...(settle !== null && settle.outcome !== "no_view" ? { dirtyPaths: settle.dirtyPaths } : {}) };
    } catch (error) { consumeKnownError(error); mirror = { outcome: "pull_failed", nextAction: "The center effect stands; rerun ha daemon fleet edge sync to project it into the local mirror.", error: error instanceof Error ? error.message : String(error) }; }
  }
  const receipt = result.receipt ?? { outcome: result.outcome, code: result.code };
  const ok = applied && (mirror === null || mirror.outcome !== "pull_blocked");
  return { schema: "command-receipt/v2", ok, command: action.kind, outcome: result.outcome, opId: result.opId !== "" ? result.opId : `fleet:${opId}`, revision: result.revision ?? null, canonicalOutcome: result.outcome, mirrorOutcome: mirror === null ? "not_pulled" : mirror.outcome, ...(ok ? {} : { error: { code: result.code ?? (mirror !== null && mirror.outcome === "pull_blocked" ? "pull_blocked" : "fleet_task_rejected"), hint: conflictNextAction(staged, typeof receipt.nextAction === "string" ? receipt.nextAction : conflictCode === null ? "Inspect the fleet task receipt." : "Pull the center, rebase the local task documents, and rerun the same command; or resolve the staged conflict explicitly.") } }), ...(receipt as Record<string, unknown>), fleet: { origin: "fleet-edge", nodeId: payload.nodeId, assignmentId: payload.assignmentId, commandOpId: opId, waitOutcome: result.outcome, lease: result.lease }, ...(mirror ? { mirror } : {}), ...(staged.length ? { conflicts: staged.map((conflict) => ({ conflictId: conflict.conflictId, paths: conflict.paths, dir: conflict.dir, exits: ["resolve", "discard-local", "overwrite-center"] })) } : {}), ...(result.queuePosition !== null ? { queuePosition: result.queuePosition } : {}) } as Record<string, unknown>;
  });

  // PUSHING_DOCS_AND_TRANSITION: gather this task's dirty mirror-worktree prose
  // (doc-sync-allowed routes only, inside the assignment scope), upload the
  // bytes as claims, and carry descriptors plus the mirror base cut on the
  // command frame.
  async function attachTaskDocs(): Promise<{ readonly docChanges: readonly { readonly path: string; readonly baseBlobSha256: string | null; readonly policyId: string; readonly candidate: FleetDescriptor }[]; readonly mirrorBaseCut: { readonly revision: number; readonly headDigest: string } } | null> {
    if (taskId === null || workspaceRoot === null || action.kind === "task-create") return null;
    const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
    if (view === null) return null;
    cacheFleetMirrorDirtyBases(payload.viewRoot, payload.repoId);
    const packagePath = fleetExactTaskPackagePath(view, taskId);
    if (packagePath === null) return null;
    const scope = fleetEdgeScopePaths(payload.assignmentId, payload.rosterPath);
    const candidates = scanFleetMirrorWorktree(view).changes.filter((change) => change.path.startsWith(`${packagePath}/`) && (scope === null || scope.some((allowed) => change.path === allowed || change.path.startsWith(`${allowed}/`))));
    if (candidates.length === 0) return null;
    const descriptors = await runFleetUploadClient({ ...peer, timeoutMs: 60_000, changes: candidates.map((change) => ({ path: change.path, body: Buffer.from(change.bytes), mediaType: change.mediaType })) });
    return { docChanges: candidates.map((change, index) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, policyId: classifyTextualArtifactPath(change.path)?.policyId ?? DOC_POLICY_ID, candidate: descriptors[index]! })), mirrorBaseCut: { revision: view.revision, headDigest: view.headDigest } };
  }
}
function conflictNextAction(staged: readonly FleetStagedConflict[], fallback: string): string { return staged.length > 0 ? `The command was rejected and its divergence is staged at ${staged[0]!.dir}; exit explicitly with ha doc conflict resolve|discard-local|overwrite-center ${staged[0]!.conflictId}.` : fallback; }
const FLEET_DOC_CONFLICT_CODES = Object.freeze(["mirror_behind_center", "base_blob_changed", "base_ledger_changed"]);
function transientResult(result: Awaited<ReturnType<typeof runFleetTaskCommandClient>>): boolean { return result.outcome === "op_rejected" && ["center_closing", "client_disconnected", "lease_state_unavailable", "op_in_flight"].includes(result.code ?? ""); }
function retryable(error: unknown): boolean { if (error instanceof FleetRemoteError) return error.retryable; if (error instanceof FleetEdgeTaskError) return false; const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : null; if (code && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ERR_TLS"].some((value) => code.includes(value))) return true; return error instanceof Error && /Fleet response timeout|Fleet connection closed|Fleet stream ended mid-frame|session ready expected|task result expected|daemon closed/u.test(error.message); }
function backoff(attempt: number): number { const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt); return Math.floor(Math.random() * ceiling) + 1; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }); }
