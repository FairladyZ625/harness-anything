// Class-B sync (design-v2 §3): one explicit `ha doc sync` round on a
// remote-edge workspace — COMPARING_WITH_CENTER (a replica pull IS the
// comparison: "current" means the center has not moved), then PUSHING the
// shared-surface prose that is dirty in the mirror worktree, or PULLING when
// the center advanced. A center that moved the same paths the edge changed
// rejects the push (CENTER_REJECTED) and the divergence is staged — never
// merged, never silently overwritten. The same module serves the three
// explicit conflict exits (resolve / discard-local / overwrite-center).
//
// An unresolved staged conflict is a persistent gate on its paths (design §4):
// rounds that would touch a gated path refuse until an explicit exit resolves
// the record, and every receipt distinguishes canonicalOutcome from
// mirrorOutcome so a blocked pull can never masquerade as synced.
import { readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, sha256Bytes } from "../../kernel/src/index.ts";
import { runFleetReplicaPullClient, runFleetWriteClient } from "./fleet/edge.ts";
import { fleetEdgeCredential, fleetEdgeScopePaths, FleetEdgeTaskError } from "./fleet-edge-task.ts";
import { applyFleetMirrorCut, cacheFleetMirrorDirtyBases, fleetConflictSideFile, locateFleetMirrorView, readFleetConflictRecord, readFleetUnresolvedConflicts, restoreFleetConflictCenterBytes, scanFleetMirrorWorktree, settleFleetConflictRecord, withFleetMirrorLock, type FleetConflictRecord, type FleetMirrorView, type FleetStagedConflict } from "./fleet-edge-mirror.ts";

const FLEET_PUSH_CONFLICT_CODES = Object.freeze(["base_blob_changed", "base_ledger_changed"]);
export interface FleetEdgeChannelPayload { readonly host: string; readonly port: number; readonly caPath: string; readonly servername?: string; readonly nodeId: string; readonly credential?: string; readonly rosterPath?: string; readonly assignmentId: string; readonly repoId: string; readonly viewRoot: string; readonly quotaBytes: number; readonly workspaceRoot: string }
export interface FleetEdgeDocSyncRequest { readonly payload: FleetEdgeChannelPayload & { readonly dryRun?: boolean; readonly paths?: readonly string[]; readonly timeoutMs?: number } }
export interface FleetEdgeConflictExitRequest { readonly payload: FleetEdgeChannelPayload & { readonly action: "resolve" | "discard-local" | "overwrite-center"; readonly conflictId: string } }

export async function runFleetEdgeDocSync(input: FleetEdgeDocSyncRequest): Promise<Record<string, unknown>> {
  const payload = input.payload, credential = fleetEdgeCredential(payload.nodeId, payload.credential, payload.rosterPath);
  const peer = { hostname: payload.host, port: payload.port, ca: readFileSync(payload.caPath, "utf8"), servername: payload.servername, nodeId: payload.nodeId, credential, assignmentId: payload.assignmentId }, timeoutMs = payload.timeoutMs ?? 60_000;
  const selection = payload.paths === undefined || payload.paths.length === 0 ? undefined : [...new Set(payload.paths)];
  return withFleetMirrorLock(payload.viewRoot, payload.repoId, async () => {
    // The persistent gate first: pre-existing unresolved conflicts on the
    // selection refuse the round before any transport work.
    const preView = locateFleetMirrorView(payload.viewRoot, payload.repoId);
    const gate = fleetGatedPaths(payload.workspaceRoot, payload.repoId, selection);
    if (gate.length > 0) { const records = readFleetUnresolvedConflicts(payload.workspaceRoot, payload.repoId).filter((record) => record.paths.some((row) => gate.includes(row.path))); return fleetDocSyncReceipt(false, "conflict_open", { syncState: "CONFLICT_STAGED", canonicalOutcome: "op_rejected", mirrorOutcome: "pull_blocked", ...(preView === null ? {} : cutOf(preView.revision)), conflicts: conflictSummaries(records.map((record) => ({ conflictId: record.conflictId, paths: record.paths.map((row) => row.path), dir: path.join(resolveConflictsDir(payload.workspaceRoot), record.conflictId) }))), gatedPaths: gate, nextAction: conflictHintOf(records) }); }
    // Cache dirty-path base bytes BEFORE the compare pull: the marker cut is
    // still the view's current cut at this moment, so base/ stays stageable
    // even when the pull jumps past the retention window.
    if (preView !== null) cacheFleetMirrorDirtyBases(payload.viewRoot, payload.repoId);
    // COMPARING_WITH_CENTER
    const pulled = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs });
    const settle = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: "shared-docs" });
    const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
    if (view === null) return fleetDocSyncReceipt(false, "mirror_missing", { syncState: "COMPARING_WITH_CENTER", canonicalOutcome: "applied", mirrorOutcome: "applied", ...cutOf(pulled.current.cut.revision), nextAction: "Run a task command or ha daemon fleet edge sync first so the mirror view exists, then rerun ha doc sync." });
    const scope = fleetEdgeScopePaths(payload.assignmentId, payload.rosterPath);
    const scan = scanFleetMirrorWorktree(view, selection);
    // Task-context documents never ride the shared-surface round: they travel
    // with their task commands (class A). Report them so the operator knows.
    const rideAlong = scan.changes.filter((change) => change.path.startsWith("tasks/")).map((change) => change.path);
    const shared = scan.changes.filter((change) => !change.path.startsWith("tasks/"));
    const outOfScope = scope === null ? [] : shared.filter((change) => !scope.some((allowed) => change.path === allowed || change.path.startsWith(`${allowed}/`))).map((change) => change.path);
    const candidates = scope === null ? shared : shared.filter((change) => scope.some((allowed) => change.path === allowed || change.path.startsWith(`${allowed}/`)));
    const rows = candidates.map((change) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, candidateBlobSha256: null, state: "eligible" as const }));
    if (payload.dryRun === true) return fleetDocSyncReceipt(true, null, { syncState: candidates.length > 0 ? "LOCAL_DIRTY" : settle.outcome === "pull_blocked" ? "CONFLICT_STAGED" : "SYNCED", canonicalOutcome: "applied", mirrorOutcome: settle.outcome, ...cutOf(pulled.current.cut.revision), rows, blocked: scan.blocked, rideAlongTaskPaths: rideAlong, outOfScopePaths: outOfScope, conflicts: conflictSummaries(settle.conflicts), nextAction: candidates.length > 0 ? "Run ha doc sync --submit to push this selection." : settle.outcome === "pull_blocked" ? "Resolve the staged conflicts explicitly; the pull stays blocked until then." : "No shared-surface changes to push." });
    if (settle.outcome === "pull_blocked") return fleetDocSyncReceipt(false, "pull_blocked", { syncState: "CONFLICT_STAGED", canonicalOutcome: "applied", mirrorOutcome: "pull_blocked", ...cutOf(pulled.current.cut.revision), conflicts: conflictSummaries(settle.conflicts), dirtyPaths: settle.dirtyPaths, nextAction: conflictHint(settle.conflicts) });
    if (candidates.length === 0) return fleetDocSyncReceipt(true, null, { syncState: "SYNCED", canonicalOutcome: "applied", mirrorOutcome: "applied", ...cutOf(pulled.current.cut.revision), blocked: scan.blocked, rideAlongTaskPaths: rideAlong, outOfScopePaths: outOfScope, nextAction: "Mirror is current; nothing to push on the shared surface." });
    // PUSHING
    const pushed = await runFleetWriteClient({ ...peer, timeoutMs, changes: candidates.map((change) => ({ path: change.path, body: Buffer.from(change.bytes), baseBlobSha256: change.baseBlobSha256, mediaType: change.mediaType })) });
    if (pushed.center.outcome === "applied") {
      // PULLING — land this node's own effect in the mirror. A pull that finds
      // another divergence reports pull_blocked and ok:false; canonical
      // success is never presented as locally synced (§8).
      const landed = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs });
      const after = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: "shared-docs" });
      const blocked = after.outcome === "pull_blocked";
      return fleetDocSyncReceipt(!blocked, blocked ? "pull_blocked" : null, { syncState: blocked ? "PULL_BLOCKED" : "SYNCED", canonicalOutcome: "applied", mirrorOutcome: after.outcome, ...cutOf(landed.current.cut.revision), pushed: rows, conflicts: conflictSummaries(after.conflicts), dirtyPaths: after.dirtyPaths, nextAction: blocked ? conflictHint(after.conflicts) : "Shared-surface documents pushed and the mirror is current." });
    }
    if (pushed.center.code !== null && (FLEET_PUSH_CONFLICT_CODES as readonly string[]).includes(pushed.center.code)) {
      // CENTER_REJECTED: fetch the center bytes and stage whatever diverged.
      // A same-path move stages base/local/center with its exits; a
      // ledger-only move stages nothing and the receipt says CENTER_REJECTED
      // with a rerun action instead of claiming CONFLICT_STAGED.
      const staged = await settlePushRejection(payload, peer, timeoutMs, pushed.center.code ?? "base_blob_changed");
      return fleetDocSyncReceipt(staged.blocked, staged.blocked ? "pull_blocked" : "center_rejected", { syncState: staged.blocked ? "CONFLICT_STAGED" : "CENTER_REJECTED", canonicalOutcome: "op_rejected", mirrorOutcome: staged.blocked ? "pull_blocked" : "applied", ...(staged.cut === null ? {} : cutOf(staged.cut)), code: pushed.center.code, pushed: rows, conflicts: conflictSummaries(staged.conflicts), nextAction: staged.blocked ? conflictHint(staged.conflicts) : "The center moved while this push was in flight; rerun ha doc sync to compare on the fresh base." });
    }
    return fleetDocSyncReceipt(false, pushed.center.code ?? "doc_push_rejected", { syncState: "CENTER_REJECTED", canonicalOutcome: "op_rejected", mirrorOutcome: "not_pulled", code: pushed.center.code, pushed: rows, nextAction: "The center refused this submission outright (scope or policy); inspect the receipt and adjust the selection." });
  });
}

// Deterministically testable settlement of a rejected push (F5): always pull
// and materialize the fresh center, then report exactly what staged.
export async function settlePushRejection(payload: FleetEdgeChannelPayload & { readonly paths?: readonly string[] }, peer: { readonly hostname: string; readonly port: number; readonly ca: string; readonly servername?: string; readonly nodeId: string; readonly credential: string; readonly assignmentId: string }, timeoutMs: number, code: string): Promise<{ readonly blocked: boolean; readonly cut: number | null; readonly conflicts: readonly FleetStagedConflict[] }> {
  let fresh: Awaited<ReturnType<typeof runFleetReplicaPullClient>> | null = null;
  try { fresh = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs }); }
  catch (error) { consumeKnownError(error); }
  const settle = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "push-rejected", { kind: "shared-docs", code });
  return { blocked: settle.outcome === "pull_blocked", cut: fresh === null ? settle.toRevision : fresh.current.cut.revision, conflicts: settle.conflicts };
}

export async function runFleetEdgeConflictExit(input: FleetEdgeConflictExitRequest): Promise<Record<string, unknown>> {
  const payload = input.payload;
  return withFleetMirrorLock(payload.viewRoot, payload.repoId, async () => {
    const record = readFleetConflictRecord(payload.workspaceRoot, payload.conflictId);
    if (record.state === "resolved") return { schema: "command-receipt/v2", ok: true, command: `doc-conflict-${payload.action}`, outcome: "applied", conflictId: record.conflictId, state: record.state, resolvedVia: record.resolvedVia, nextAction: "This conflict is already resolved." };
    if (payload.action === "resolve") { const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "resolve"); return { schema: "command-receipt/v2", ok: true, command: "doc-conflict-resolve", outcome: "applied", conflictId: settled.conflictId, state: settled.state, paths: settled.paths.map((row) => row.path), nextAction: "Record closed. Merge base/local/center into the mirror worktree yourself, then rerun ha doc sync (or the task command) on the fresh base." }; }
    const credential = fleetEdgeCredential(payload.nodeId, payload.credential, payload.rosterPath);
    const peer = { hostname: payload.host, port: payload.port, ca: readFileSync(payload.caPath, "utf8"), servername: payload.servername, nodeId: payload.nodeId, credential, assignmentId: payload.assignmentId };
    const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
    if (view === null) return { schema: "command-receipt/v2", ok: false, command: `doc-conflict-${payload.action}`, outcome: "op_rejected", conflictId: record.conflictId, code: "mirror_missing", canonicalOutcome: "op_rejected", mirrorOutcome: "not_pulled", error: { code: "mirror_missing", hint: "The mirror view is gone; rerun a task command or ha daemon fleet edge sync, then retry the exit." } };
    if (payload.action === "discard-local") { for (const row of record.paths) restoreFleetConflictCenterBytes(payload.workspaceRoot, record.conflictId, view, row); const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "discard-local"); return { schema: "command-receipt/v2", ok: true, command: "doc-conflict-discard-local", outcome: "applied", conflictId: settled.conflictId, state: settled.state, canonicalOutcome: "applied", mirrorOutcome: "applied", paths: settled.paths.map((row) => row.path), nextAction: "Local changes for these paths were discarded; the mirror worktree now holds the recorded center bytes." }; }
    // overwrite-center is idempotent and pull-first: if the center already
    // holds the staged local bytes (a prior attempt crashed after the append),
    // the exit settles without pushing again. Otherwise it submits with the
    // record's center digest as the expected base; a center that moved again
    // refuses again and the record stays staged.
    const localFiles = record.paths.flatMap((row) => { const file = fleetConflictSideFile(payload.workspaceRoot, record.conflictId, row.path, "local"); return file === null ? [] : [{ row, bytes: readFileSync(file) }]; });
    if (localFiles.length === 0) return { schema: "command-receipt/v2", ok: false, command: "doc-conflict-overwrite-center", outcome: "op_rejected", conflictId: record.conflictId, code: "local_side_missing", canonicalOutcome: "op_rejected", mirrorOutcome: "not_pulled", error: { code: "local_side_missing", hint: "This record has no local bytes to overwrite with (a deletion); use discard-local instead." } };
    const already = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs: 60_000 });
    const current = locateFleetMirrorView(payload.viewRoot, payload.repoId);
    if (current !== null && localFiles.every(({ row, bytes }) => current.entries.get(row.path)?.sha256 === sha256Bytes(bytes))) {
      const after = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: record.kind === "task-docs" ? "task-docs" : "shared-docs" });
      const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "overwrite-center");
      const blocked = after.outcome === "pull_blocked";
      return { schema: "command-receipt/v2", ok: !blocked, command: "doc-conflict-overwrite-center", outcome: "applied", conflictId: settled.conflictId, state: settled.state, canonicalOutcome: "applied", mirrorOutcome: blocked ? "pull_blocked" : "applied", idempotent: true, cut: already.current.cut, conflicts: conflictSummaries(after.conflicts), ...(blocked ? { code: "pull_blocked", error: { code: "pull_blocked", hint: `The prior overwrite was already canonical, but this pull found another divergence: ${conflictHint(after.conflicts)}` }, nextAction: conflictHint(after.conflicts) } : { nextAction: "The center already held the staged local bytes; the record is settled." }) };
    }
    const pushed = await runFleetWriteClient({ ...peer, timeoutMs: 60_000, executionId: record.executionId, changes: localFiles.map(({ row, bytes }) => ({ path: row.path, body: bytes, baseBlobSha256: row.centerBlobSha256 })) });
    if (pushed.center.outcome !== "applied") return { schema: "command-receipt/v2", ok: false, command: "doc-conflict-overwrite-center", outcome: "op_rejected", conflictId: record.conflictId, code: pushed.center.code ?? "doc_push_rejected", canonicalOutcome: "op_rejected", mirrorOutcome: "not_pulled", error: { code: pushed.center.code ?? "doc_push_rejected", hint: pushed.center.code === "lease_conflict" ? "Task-context overwrite requires the current holder; acquire the task lease first, then retry the exit." : pushed.center.code === "task_docs_require_task_command" ? "Task-context documents ride the lease-brokered task command; run the task command instead of this exit." : "The center refused the overwrite (it moved again or the policy denies it); rerun ha doc sync and restage." } };
    const landed = await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes, timeoutMs: 60_000 });
    const after = applyFleetMirrorCut(payload.viewRoot, payload.repoId, payload.workspaceRoot, "pull", { kind: record.kind === "task-docs" ? "task-docs" : "shared-docs" });
    const blocked = after.outcome === "pull_blocked";
    // The record settles when ITS paths converged; an unrelated divergence in
    // the same pull is reported (and staged) instead of being swallowed.
    const converged = localFiles.every(({ row, bytes }) => { const entry = locateFleetMirrorView(payload.viewRoot, payload.repoId)?.entries.get(row.path); return entry === undefined || entry.sha256 === sha256Bytes(bytes); });
    if (converged) { const settled = settleFleetConflictRecord(payload.workspaceRoot, payload.conflictId, "overwrite-center"); return { schema: "command-receipt/v2", ok: !blocked, command: "doc-conflict-overwrite-center", outcome: "applied", conflictId: settled.conflictId, state: settled.state, canonicalOutcome: "applied", mirrorOutcome: blocked ? "pull_blocked" : "applied", ...(blocked ? { code: "pull_blocked", error: { code: "pull_blocked", hint: `The overwrite landed, but the mirror pull found another divergence: ${conflictHint(after.conflicts)}` } } : {}), revision: pushed.center.revision, cut: landed.current.cut, conflicts: conflictSummaries(after.conflicts), nextAction: blocked ? conflictHint(after.conflicts) : "The staged local bytes now overwrite the recorded center base; the mirror is current." }; }
    return { schema: "command-receipt/v2", ok: false, command: "doc-conflict-overwrite-center", outcome: "op_rejected", conflictId: record.conflictId, code: "overwrite_not_converged", canonicalOutcome: "applied", mirrorOutcome: "pull_blocked", revision: pushed.center.revision, cut: landed.current.cut, conflicts: conflictSummaries(after.conflicts), error: { code: "overwrite_not_converged", hint: "The overwrite landed at the center but the mirror still diverges on these paths; rerun ha doc sync and inspect the fresh staging." }, nextAction: conflictHint(after.conflicts) };
  });
}

function resolveConflictsDir(workspaceRoot: string): string { return path.join(workspaceRoot, ".harness", "conflicts"); }
function fleetGatedPaths(workspaceRoot: string, repoId: string, selection: readonly string[] | undefined): string[] {
  const unresolved = readFleetUnresolvedConflicts(workspaceRoot, repoId);
  if (unresolved.length === 0) return [];
  const gated = new Set(unresolved.flatMap((record) => record.paths.map((row) => row.path)));
  if (selection === undefined) return [...gated].sort();
  return selection.filter((path) => gated.has(path));
}
function fleetDocSyncReceipt(ok: boolean, code: string | null, fields: Record<string, unknown>): Record<string, unknown> { return { schema: "command-receipt/v2", ok, command: "doc-sync", outcome: ok ? "applied" : "op_rejected", ...(code !== null ? { code } : {}), ...(ok ? {} : { error: { code: code ?? "doc_sync_failed", hint: typeof fields.nextAction === "string" ? fields.nextAction : "Inspect the doc sync receipt." } }), ...fields } as Record<string, unknown>; }
function cutOf(revision: number): { cut: { revision: number } } { return { cut: { revision } }; }
function conflictSummaries(conflicts: readonly { readonly conflictId: string; readonly paths: readonly string[]; readonly dir?: string }[]): readonly Record<string, unknown>[] { return conflicts.map((conflict) => ({ conflictId: conflict.conflictId, paths: conflict.paths, ...(conflict.dir ? { dir: conflict.dir } : {}), exits: ["resolve", "discard-local", "overwrite-center"] })); }
function conflictHint(conflicts: readonly FleetStagedConflict[]): string { const first = conflicts[0]; return first === undefined ? "No staged conflict carries this outcome." : `Divergence staged at ${first.dir}; exit explicitly with ha doc conflict resolve|discard-local|overwrite-center ${first.conflictId}.`; }
function conflictHintOf(records: readonly FleetConflictRecord[]): string { const first = records[0]; return first === undefined ? "Unresolved staged conflicts gate these paths." : `An unresolved staged conflict (${first.conflictId}) gates these paths; exit explicitly with ha doc conflict resolve|discard-local|overwrite-center ${first.conflictId}.`; }
export type { FleetConflictRecord, FleetMirrorView };
export { FleetEdgeTaskError };
