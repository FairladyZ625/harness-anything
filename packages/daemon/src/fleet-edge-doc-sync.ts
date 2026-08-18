// Class-B sync (design-v2 §3): one explicit `ha doc sync` round on a
// remote-edge workspace — COMPARING_WITH_CENTER (a replica pull IS the
// comparison: "current" means the center has not moved), then PUSHING the
// shared-surface prose that is dirty in the mirror worktree, or PULLING when
// the center advanced. A center that moved the same paths the edge changed
// rejects the push (CENTER_REJECTED) and the divergence is staged — never
// merged, never silently overwritten. The same module serves the three
// explicit conflict exits (resolve / discard-local / overwrite-center).
import { readFileSync } from "node:fs";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { runFleetReplicaPullClient, runFleetWriteClient } from "./fleet/edge.ts";
import { fleetEdgeCredential, fleetEdgeScopePaths, FleetEdgeTaskError } from "./fleet-edge-task.ts";
import { applyFleetMirrorCut, fleetConflictSideFile, locateFleetMirrorView, readFleetConflictRecord, restoreFleetConflictCenterBytes, scanFleetMirrorWorktree, settleFleetConflictRecord, type FleetConflictRecord, type FleetMirrorView, type FleetStagedConflict } from "./fleet-edge-mirror.ts";

const FLEET_PUSH_CONFLICT_CODES = Object.freeze(["base_blob_changed", "base_ledger_changed"]);
export interface FleetEdgeChannelPayload { readonly host: string; readonly port: number; readonly caPath: string; readonly servername?: string; readonly nodeId: string; readonly credential?: string; readonly rosterPath?: string; readonly assignmentId: string; readonly repoId: string; readonly viewRoot: string; readonly quotaBytes: number; readonly workspaceRoot: string }
export interface FleetEdgeDocSyncRequest { readonly payload: FleetEdgeChannelPayload & { readonly dryRun?: boolean; readonly paths?: readonly string[]; readonly timeoutMs?: number } }
export interface FleetEdgeConflictExitRequest { readonly payload: FleetEdgeChannelPayload & { readonly action: "resolve" | "discard-local" | "overwrite-center"; readonly conflictId: string } }

export async function runFleetEdgeDocSync(input: FleetEdgeDocSyncRequest): Promise<Record<string, unknown>> {
  const payload = input.payload, credential = fleetEdgeCredential(payload.nodeId, payload.credential, payload.rosterPath);
  const peer = { hostname: payload.host, port: payload.port, ca: readFileSync(payload.caPath, "utf8"), servername: payload.servername, nodeId: payload.nodeId, credential, assignmentId: payload.assignmentId }, timeoutMs = payload.timeoutMs ?? 60_000;
  // COMPARING_WITH_CENTER
  const pulled = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs });
  const settle = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: "shared-docs" });
  const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
  if (view === null) return fleetDocSyncReceipt(false, "mirror_missing", { syncState: "COMPARING_WITH_CENTER", ...cutOf(pulled.current.cut.revision), nextAction: "Run a task command or ha daemon fleet edge sync first so the mirror view exists, then rerun ha doc sync." });
  const scope = fleetEdgeScopePaths(payload.assignmentId, payload.rosterPath);
  const scan = scanFleetMirrorWorktree(view, payload.paths);
  // Task-context documents never ride the shared-surface round: they travel
  // with their task commands (class A). Report them so the operator knows.
  const rideAlong = scan.changes.filter((change) => change.path.startsWith("tasks/")).map((change) => change.path);
  const shared = scan.changes.filter((change) => !change.path.startsWith("tasks/"));
  const outOfScope = scope === null ? [] : shared.filter((change) => !scope.some((allowed) => change.path === allowed || change.path.startsWith(`${allowed}/`))).map((change) => change.path);
  const candidates = scope === null ? shared : shared.filter((change) => scope.some((allowed) => change.path === allowed || change.path.startsWith(`${allowed}/`)));
  const rows = candidates.map((change) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, candidateBlobSha256: null, state: "eligible" as const }));
  if (payload.dryRun === true) return fleetDocSyncReceipt(true, null, { syncState: candidates.length > 0 ? "LOCAL_DIRTY" : settle.outcome === "pull_blocked" ? "CONFLICT_STAGED" : "SYNCED", ...cutOf(pulled.current.cut.revision), rows, blocked: scan.blocked, rideAlongTaskPaths: rideAlong, outOfScopePaths: outOfScope, conflicts: conflictSummaries(settle.conflicts), nextAction: candidates.length > 0 ? "Run ha doc sync --submit to push this selection." : settle.outcome === "pull_blocked" ? "Resolve the staged conflicts explicitly; the pull stays blocked until then." : "No shared-surface changes to push." });
  if (settle.outcome === "pull_blocked") return fleetDocSyncReceipt(false, "pull_blocked", { syncState: "CONFLICT_STAGED", ...cutOf(pulled.current.cut.revision), conflicts: conflictSummaries(settle.conflicts), dirtyPaths: settle.dirtyPaths, nextAction: conflictHint(settle.conflicts) });
  if (candidates.length === 0) return fleetDocSyncReceipt(true, null, { syncState: "SYNCED", ...cutOf(pulled.current.cut.revision), blocked: scan.blocked, rideAlongTaskPaths: rideAlong, outOfScopePaths: outOfScope, nextAction: "Mirror is current; nothing to push on the shared surface." });
  // PUSHING
  const pushed = await runFleetWriteClient({ ...peer, timeoutMs, changes: candidates.map((change) => ({ path: change.path, body: Buffer.from(change.bytes), baseBlobSha256: change.baseBlobSha256, mediaType: change.mediaType })) });
  if (pushed.center.outcome === "applied") {
    // PULLING — land this node's own effect in the mirror.
    const landed = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs });
    const after = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: "shared-docs" });
    return fleetDocSyncReceipt(true, null, { syncState: after.outcome === "pull_blocked" ? "PULL_BLOCKED" : "SYNCED", ...cutOf(landed.current.cut.revision), pushed: rows, mirrorOutcome: after.outcome, conflicts: conflictSummaries(after.conflicts), dirtyPaths: after.dirtyPaths, nextAction: after.outcome === "pull_blocked" ? conflictHint(after.conflicts) : "Shared-surface documents pushed and the mirror is current." });
  }
  if (pushed.center.code !== null && (FLEET_PUSH_CONFLICT_CODES as readonly string[]).includes(pushed.center.code)) {
    // CENTER_REJECTED -> CONFLICT_STAGED: fetch the center bytes and stage them
    // beside the local ones. Nothing is merged and the local worktree is left
    // exactly as it was.
    const fresh = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs }).catch((error: unknown) => { consumeKnownError(error); return null; });
    const staged = fresh === null ? applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "push-rejected", { kind: "shared-docs", code: pushed.center.code ?? undefined }) : null;
    return fleetDocSyncReceipt(false, "center_rejected", { syncState: "CONFLICT_STAGED", ...(fresh === null ? {} : cutOf(fresh.current.cut.revision)), code: pushed.center.code, pushed: rows, ...(staged !== null ? { conflicts: conflictSummaries(staged.conflicts) } : {}), ...(staged !== null && staged.conflicts.length === 0 ? { note: "The center rejected the push but no same-path divergence staged; rerun ha doc sync after the mirror refreshes." } : {}), nextAction: staged !== null && staged.conflicts.length > 0 ? conflictHint(staged.conflicts) : "The center moved while this push was in flight; rerun ha doc sync to compare on the fresh base." });
  }
  return fleetDocSyncReceipt(false, pushed.center.code ?? "doc_push_rejected", { syncState: "CENTER_REJECTED", code: pushed.center.code, pushed: rows, nextAction: "The center refused this submission outright (scope or policy); inspect the receipt and adjust the selection." });
}

export async function runFleetEdgeConflictExit(input: FleetEdgeConflictExitRequest): Promise<Record<string, unknown>> {
  const payload = input.payload, record = readFleetConflictRecord(payload.workspaceRoot, payload.conflictId);
  if (record.state === "resolved") return { schema: "command-receipt/v2", ok: true, command: `doc-conflict-${payload.action}`, outcome: "applied", conflictId: record.conflictId, state: record.state, resolvedVia: record.resolvedVia, nextAction: "This conflict is already resolved." };
  if (payload.action === "resolve") { const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "resolve"); return { schema: "command-receipt/v2", ok: true, command: "doc-conflict-resolve", outcome: "applied", conflictId: settled.conflictId, state: settled.state, paths: settled.paths.map((row) => row.path), nextAction: "Record closed. Merge base/local/center into the mirror worktree yourself, then rerun ha doc sync (or the task command) on the fresh base." }; }
  const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
  if (view === null) return { schema: "command-receipt/v2", ok: false, command: `doc-conflict-${payload.action}`, outcome: "op_rejected", conflictId: record.conflictId, code: "mirror_missing", error: { code: "mirror_missing", hint: "The mirror view is gone; rerun a task command or ha daemon fleet edge sync, then retry the exit." } };
  if (payload.action === "discard-local") { for (const row of record.paths) restoreFleetConflictCenterBytes(payload.workspaceRoot, record.conflictId, view, row); const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "discard-local"); return { schema: "command-receipt/v2", ok: true, command: "doc-conflict-discard-local", outcome: "applied", conflictId: settled.conflictId, state: settled.state, paths: settled.paths.map((row) => row.path), nextAction: "Local changes for these paths were discarded; the mirror worktree now holds the recorded center bytes." }; }
  // overwrite-center: the staged center digest is the expected base; if the
  // center moved again the submission is refused again (design §4 exit 3).
  const credential = fleetEdgeCredential(payload.nodeId, payload.credential, payload.rosterPath);
  const peer = { hostname: payload.host, port: payload.port, ca: readFileSync(payload.caPath, "utf8"), servername: payload.servername, nodeId: payload.nodeId, credential, assignmentId: payload.assignmentId };
  const localFiles = record.paths.flatMap((row) => { const file = fleetConflictSideFile(payload.workspaceRoot, record.conflictId, row.path, "local"); return file === null ? [] : [{ row, bytes: readFileSync(file) }]; });
  if (localFiles.length === 0) return { schema: "command-receipt/v2", ok: false, command: "doc-conflict-overwrite-center", outcome: "op_rejected", conflictId: record.conflictId, code: "local_side_missing", error: { code: "local_side_missing", hint: "This record has no local bytes to overwrite with (a deletion); use discard-local instead." } };
  const pushed = await runFleetWriteClient({ ...peer, timeoutMs: 60_000, executionId: record.executionId, changes: localFiles.map(({ row, bytes }) => ({ path: row.path, body: bytes, baseBlobSha256: row.centerBlobSha256 })) });
  if (pushed.center.outcome !== "applied") return { schema: "command-receipt/v2", ok: false, command: "doc-conflict-overwrite-center", outcome: "op_rejected", conflictId: record.conflictId, code: pushed.center.code ?? "doc_push_rejected", error: { code: pushed.center.code ?? "doc_push_rejected", hint: pushed.center.code === "lease_conflict" ? "Task-context overwrite requires the current holder; acquire the task lease first, then retry the exit." : "The center refused the overwrite (it moved again or the policy denies it); rerun ha doc sync and restage." } };
  const landed = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs: 60_000 });
  applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: record.kind === "task-docs" ? "task-docs" : "shared-docs" });
  const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "overwrite-center");
  return { schema: "command-receipt/v2", ok: true, command: "doc-conflict-overwrite-center", outcome: "applied", conflictId: settled.conflictId, state: settled.state, paths: settled.paths.map((row) => row.path), revision: pushed.center.revision, cut: landed.current.cut, nextAction: "The staged local bytes now overwrite the recorded center base; the mirror is current." };
}

function fleetDocSyncReceipt(ok: boolean, code: string | null, fields: Record<string, unknown>): Record<string, unknown> { return { schema: "command-receipt/v2", ok, command: "doc-sync", outcome: ok ? "applied" : "op_rejected", ...(code !== null ? { code } : {}), ...(ok ? {} : { error: { code: code ?? "doc_sync_failed", hint: typeof fields.nextAction === "string" ? fields.nextAction : "Inspect the doc sync receipt." } }), ...fields } as Record<string, unknown>; }
function cutOf(revision: number): { cut: { revision: number } } { return { cut: { revision } }; }
function conflictSummaries(conflicts: readonly FleetStagedConflict[]): readonly Record<string, unknown>[] { return conflicts.map((conflict) => ({ conflictId: conflict.conflictId, paths: conflict.paths, dir: conflict.dir, exits: ["resolve", "discard-local", "overwrite-center"] })); }
function conflictHint(conflicts: readonly FleetStagedConflict[]): string { const first = conflicts[0]; return first === undefined ? "No staged conflict carries this outcome." : `Divergence staged at ${first.dir}; exit explicitly with ha doc conflict resolve|discard-local|overwrite-center ${first.conflictId}.`; }
export type { FleetConflictRecord, FleetMirrorView };
export { FleetEdgeTaskError };
