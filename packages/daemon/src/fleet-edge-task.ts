// Edge-side product write path: routes one `ha task ...` write command through
// the fleet TLS channel, attaches to the center's wait queue for as long as the
// caller is willing to wait, reconnects with full-jitter exponential backoff
// when the transport drops mid-wait (same opId, so the center coalesces), and
// pulls the replica view after an applied outcome so the center effect lands
// in the local mirror.
//
// W3-C class-A sync (design-v2 §3): when the command's task package has local
// registered-harness changes, they ride the same command — uploaded as claims and
// carried with the mirror base cut — so the center validates holder, document
// base, and lifecycle transition as one serial command. A conflict rejects the
// whole command and stages base/local/center into .harness/conflicts; an
// applied outcome auto-pulls and reports the dual-axis mirror outcome.
import { commandDescriptorForAction } from "./protocol/daemon-protocol-commands.ts";
import { randomUUID } from "node:crypto";
import { reviewReportRelativePath } from "./reviewer-artifact-publication.ts";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  classifyTextualArtifactPath,
  classifyRawArtifactPath,
  resolveDocRoute,
  documentPath,
  consumeKnownError,
  DOC_POLICY_ID,
  RAW_ARTIFACT_MAX_BYTES,
  resolveHarnessLayout,
} from "@harness-anything/kernel";
import {
  FleetRemoteError,
  readFleetRepositoryMetadataClient,
  runFleetReplicaPullClient,
  runFleetRepositoryReadClient,
  runFleetTaskCommandClient,
  runFleetRuntimeReadClient,
  runFleetUploadClient,
  runFleetWriteClient,
} from "./fleet/edge.ts";
import type { FleetDescriptor } from "./fleet/contract.ts";
import type { FleetTaskAction } from "./fleet/contract.ts";
import {
  applyFleetMirrorCut,
  cacheFleetMirrorDirtyBases,
  locateFleetMirrorView,
  readFleetUnresolvedConflicts,
  withFleetMirrorLock,
  type FleetMirrorView,
  type FleetStagedConflict,
} from "./fleet-edge-mirror.ts";
import { reclaimEdgeTaskWorktrees } from "./fleet-edge-worktree-reclaim.ts";

import { prepareEdgeTaskDelivery, type FleetDeliveryTask } from "./fleet-task-delivery.ts";
import { readEdgeRepository } from "./fleet-edge-task-read.ts";

const BACKOFF_MIN_MS = 250,
  BACKOFF_MAX_MS = 30_000;
export interface FleetEdgeTaskRequest {
  readonly payload: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly nodeId: string;
    readonly credential: string;
    readonly executionCredential?: string;
    readonly principalId?: string;
    readonly repoId: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
    readonly workspaceRoot?: string;
    readonly waitTimeoutMs?: number;
    readonly maxAgeMs?: number;
    readonly maxLagRevisions?: number;
    readonly action: FleetTaskAction;
  };
}
export class FleetEdgeTaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FleetEdgeTaskError";
    this.code = code;
  }
}

type EdgeWriteCut = { readonly revision: number; readonly headDigest: string };
const recentAppliedCuts = new Map<string, EdgeWriteCut>();

function edgeReadStateKey(viewRoot: string, repoId: string, nodeId: string): string {
  return `${viewRoot}\u0000${repoId}\u0000${nodeId}`;
}

function rememberAppliedCut(
  viewRoot: string,
  repoId: string,
  nodeId: string,
  cut: EdgeWriteCut | null | undefined,
): void {
  if (!cut || !Number.isSafeInteger(cut.revision) || typeof cut.headDigest !== "string") return;
  const key = edgeReadStateKey(viewRoot, repoId, nodeId),
    previous = recentAppliedCuts.get(key);
  if (!previous || cut.revision >= previous.revision) recentAppliedCuts.set(key, cut);
}

// Conservative task-path predicate for the unresolved-conflict gate. It
// deliberately has no ULID alphabet heuristic, so lowercase generated ids
// and plain ids are both covered. Automatic carry resolves the exact package
// below from its canonical INDEX instead of trusting this prefix predicate.
export function fleetDocPathInTaskPackage(value: string, taskId: string): boolean {
  const match = /^tasks\/([^/]+)\//u.exec(value);
  if (!match) return false;
  const folder = match[1]!;
  return folder === taskId || folder.startsWith(`${taskId}-`);
}

// Folder names alone are only a candidate because legal task ids can contain
// hyphens: `task-direct-other` may be either a slugged `task-direct` package
// or a distinct task id. The canonical package INDEX owns that distinction.
// Returning null on absent/ambiguous metadata fails closed for automatic
// carry, while the center remains the final task/lease authority.
function fleetExactTaskPackagePath(view: FleetMirrorView, workspaceRoot: string, taskId: string): string | null {
  const materializedRoot = resolveHarnessLayout(workspaceRoot).authoredRoot;
  const paths = new Set<string>();
  for (const logical of view.entries.keys()) {
    const match = /^(tasks\/[^/]+)\/INDEX\.md$/u.exec(logical);
    if (!match) continue;
    try {
      const body = readFileSync(path.join(materializedRoot, ...logical.split("/")), "utf8");
      if (body.split(/\r?\n/u).some((line) => line === `task_id: ${taskId}` || line === `taskId: ${taskId}`))
        paths.add(match[1]!);
    } catch (error) {
      consumeKnownError(error);
    }
  }
  return paths.size === 1 ? [...paths][0]! : null;
}

/** Reads an edge answers from its own replica cell; the remaining repository reads still forward to the center. */
export function isFleetEdgeRepositoryRead(action: FleetTaskAction): boolean {
  return commandDescriptorForAction(action.kind).admission["remote-edge"] === "edge-replica";
}

/** A repository read on an edge: answered by the host's edge cell after this edge's own writes land. */
export async function runFleetEdgeRepositoryRead(
  input: FleetEdgeTaskRequest,
  readLocal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const payload = input.payload,
    minCut = recentAppliedCuts.get(edgeReadStateKey(payload.viewRoot, payload.repoId, payload.nodeId));
  return readEdgeRepository(
    {
      viewRoot: payload.viewRoot,
      repoId: payload.repoId,
      nodeId: payload.nodeId,
      action: payload.action,
      ...(minCut ? { minCut } : {}),
    },
    () =>
      runFleetReplicaPullClient({
        hostname: payload.host,
        port: payload.port,
        ca: readFileSync(payload.caPath, "utf8"),
        servername: payload.servername,
        nodeId: payload.nodeId,
        credential: payload.credential,
        repoId: payload.repoId,
        viewRoot: payload.viewRoot,
        diskQuotaBytes: payload.quotaBytes,
      }),
    async () => {
      const receipt = await readLocal();
      return {
        schema: "command-receipt/v2",
        command: payload.action.kind,
        ok: receipt.outcome === "applied",
        ...receipt,
      };
    },
  );
}

export async function runFleetEdgeTask(
  input: FleetEdgeTaskRequest,
  readAccessToken?: () => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
  const payload = input.payload;
  let action = payload.action;
  const readOnly = commandDescriptorForAction(action.kind).commandClass === "repo-read";
  const credential = payload.credential;
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  const waitMs =
    payload.waitTimeoutMs !== undefined && Number.isSafeInteger(payload.waitTimeoutMs) && payload.waitTimeoutMs > 0
      ? payload.waitTimeoutMs
      : 60_000;
  const opId = randomUUID(),
    peer = {
      hostname: payload.host,
      port: payload.port,
      ca: readFileSync(payload.caPath, "utf8"),
      servername: payload.servername,
      nodeId: payload.nodeId,
      credential,
      ...(payload.executionCredential ? { executionCredential: payload.executionCredential } : {}),
      repoId: payload.repoId,
    };
  const declaration = commandDescriptorForAction(action.kind);
  if ("repositoryRead" in declaration && declaration.repositoryRead === true) {
    const receipt = await runFleetRepositoryReadClient({
      ...peer,
      method: "repo.task.read",
      payload: action,
      accessToken: await readAccessToken?.(),
    });
    return { schema: "command-receipt/v2", command: action.kind, ok: receipt.outcome === "applied", ...receipt };
  }
  const workspaceRoot = payload.workspaceRoot ?? null;
  // One edge/view has one registered harness materialization. Hold its round fence
  // across gate check, candidate scan/upload, center command, pull, and local
  // materialization so an A round cannot interleave with B sync (or another
  // A round) between those state-machine edges.
  return withFleetMirrorLock(payload.viewRoot, payload.repoId, async () => {
    // The unresolved-conflict gate (design §4): while this task's package has a
    // staged, unhandled divergence, its transitions stay blocked — the edge
    // refuses before any upload or center round-trip.
    if (!readOnly && workspaceRoot !== null && taskId !== null && action.kind !== "task-create") {
      const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
      const exactPackage = view === null ? null : fleetExactTaskPackagePath(view, workspaceRoot, taskId);
      const belongs = (conflictPath: string): boolean =>
        exactPackage === null
          ? fleetDocPathInTaskPackage(conflictPath, taskId)
          : conflictPath.startsWith(`${exactPackage}/`);
      const open = readFleetUnresolvedConflicts(workspaceRoot, payload.repoId)
        .flatMap((record) => record.paths.map((row) => row.path))
        .filter(belongs);
      if (open.length > 0)
        return {
          schema: "command-receipt/v2",
          ok: false,
          command: action.kind,
          outcome: "op_rejected",
          opId: `conflict-open:${taskId}`,
          canonicalOutcome: "op_rejected",
          mirrorOutcome: "conflict_open",
          code: "conflict_open",
          taskId,
          error: {
            code: "conflict_open",
            hint: `An unresolved staged conflict covers ${[...new Set(open)].sort().join(", ")}; exit explicitly with ha doc conflict resolve|discard-local|overwrite-center before rerunning this task's commands.`,
          },
        } as Record<string, unknown>;
    }
    if (action.kind === "doc-submit" && taskId !== null && workspaceRoot !== null) {
      const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
      const packagePath = view && fleetExactTaskPackagePath(view, workspaceRoot, taskId);
      if (!view || !packagePath) throw new FleetEdgeTaskError("mirror_missing", "Task package is not materialized.");
      if (action.all === true || (Array.isArray(action.paths) && action.paths.length > 0))
        throw new FleetEdgeTaskError(
          "execution_credential_rejected",
          "Task document selection cannot name other paths.",
        );
      const scan = cacheFleetMirrorDirtyBases(payload.viewRoot, payload.repoId, workspaceRoot);
      if (!scan) throw new FleetEdgeTaskError("mirror_missing", "Task document scan is unavailable.");
      const changes = scan.changes.filter((change) => change.path.startsWith(`${packagePath}/`));
      const admission = await readFleetRepositoryMetadataClient({ ...peer, taskId, actionKind: "doc-submit" });
      if (admission.actionAllowed !== true)
        throw new FleetEdgeTaskError("authorization_denied", "Task document submission is not authorized.");
      const blocked = scan.blocked.filter(
        (row) =>
          row.path.startsWith(`${packagePath}/`) &&
          (resolveDocRoute(documentPath(row.path)).allowed || classifyRawArtifactPath(row.path) !== null),
      );
      if (blocked.length) throw new FleetEdgeTaskError("preview_blocked", blocked.map((row) => row.reason).join("; "));
      if (changes.length === 0)
        return { schema: "command-receipt/v2", command: action.kind, ok: true, outcome: "no_changes" };
      const result = await runFleetWriteClient({
        ...peer,
        taskId,
        executionId: null,
        channel: "collaborator",
        changes: changes.map((change) => ({
          path: change.path,
          body: Buffer.from(change.bytes),
          baseBlobSha256: change.baseBlobSha256,
          policyId: classifyTextualArtifactPath(change.path)?.policyId ?? DOC_POLICY_ID,
          mediaType: change.mediaType,
        })),
      });
      if (result.center.outcome === "applied") {
        await runFleetReplicaPullClient({ ...peer, viewRoot: payload.viewRoot, diskQuotaBytes: payload.quotaBytes });
        const materialized = applyFleetMirrorCut(payload.viewRoot, payload.repoId, workspaceRoot, "pull", {
          kind: "task-docs",
          taskId,
          executionId: null,
        });
        if (materialized.outcome === "pull_blocked")
          throw new FleetEdgeTaskError("pull_blocked", "Task document materialization is blocked.");
      }
      return {
        ...result.center,
        schema: "command-receipt/v2",
        command: action.kind,
        ok: result.center.outcome === "applied" || result.center.outcome === "no_changes",
      };
    }
    if (action.kind === "task-submit" && workspaceRoot !== null && taskId !== null)
      action = await prepareEdgeTaskDelivery({
        workspaceRoot,
        nodeId: payload.nodeId,
        action,
        authorize: async () => {
          const metadata = await readFleetRepositoryMetadataClient({ ...peer, actionKind: "task-submit", taskId });
          if (metadata.actionAllowed !== true)
            throw new FleetEdgeTaskError(
              "authorization_denied",
              "Task submit permission is required before publishing delivery.",
            );
          return metadata.personId;
        },
        readTask: async () => {
          const current = await runFleetRuntimeReadClient({
            ...peer,
            repoId: payload.repoId,
            method: "repo.tasks.runtimeContext.read",
            payload: { taskId },
          });
          if (!current || typeof current !== "object" || !("snapshot" in current))
            throw new FleetEdgeTaskError("task_read_failed", "Center returned no current task for delivery.");
          return current.snapshot as FleetDeliveryTask;
        },
      });
    let artifact: FleetDescriptor | undefined;
    if (action.kind === "task-artifact-add") {
      const { source, content, ...target } = action;
      if ((typeof source === "string") === (typeof content === "string"))
        throw new FleetEdgeTaskError("invalid_command", "Artifact requires one file or transcript.");
      const file = typeof source === "string" ? path.resolve(workspaceRoot!, source) : null;
      if (file && statSync(file).size > RAW_ARTIFACT_MAX_BYTES)
        throw new FleetEdgeTaskError("artifact_too_large", "Artifact exceeds the content object limit.");
      [artifact] = await runFleetUploadClient({
        ...peer,
        changes: [{ path: String(target.destination), body: file ? readFileSync(file) : Buffer.from(String(content)) }],
      });
      action = target as FleetTaskAction;
    }
    const bundle = readOnly || artifact ? null : await attachTaskDocs();
    const deadline = Date.now() + waitMs + 30_000 + (bundle === null ? 0 : 60_000);
    let result: Awaited<ReturnType<typeof runFleetTaskCommandClient>> | null = null,
      attempt = 0;
    while (result === null) {
      const remaining = Math.max(1, deadline - Date.now());
      try {
        const next = await runFleetTaskCommandClient({
          ...peer,
          accessToken: await readAccessToken?.(),
          opId,
          repoId: payload.repoId,
          taskId,
          action,
          ...(artifact ? { artifact } : {}),
          waitMs,
          timeoutMs: remaining + 10_000,
          docChanges: bundle === null ? undefined : bundle.docChanges,
          mirrorBaseCut: bundle === null ? undefined : bundle.mirrorBaseCut,
        });
        if (Date.now() < deadline && transientResult(next)) {
          await sleep(fleetEdgeBackoffMs(attempt++));
          continue;
        }
        result = next;
      } catch (error) {
        if (Date.now() >= deadline || !retryable(error)) throw error;
        consumeKnownError(error);
        await sleep(fleetEdgeBackoffMs(attempt++));
      }
    }
    const applied = result.outcome === "applied";
    const conflictCode =
      result.outcome === "op_rejected" && result.code !== null && FLEET_DOC_CONFLICT_CODES.includes(result.code)
        ? result.code
        : null;
    let mirror: Record<string, unknown> | null = null;
    const staged: FleetStagedConflict[] = [];
    // Any center effect (applied) and any content conflict both end in a pull:
    // applied commands must land in the mirror, and a rejected bundle needs the
    // center bytes staged beside the local ones for the explicit exits.
    if (!readOnly && (applied || conflictCode !== null)) {
      try {
        const pulled = await runFleetReplicaPullClient({
          ...peer,
          viewRoot: payload.viewRoot,
          diskQuotaBytes: payload.quotaBytes,
          timeoutMs: 60_000,
        });
        const settle =
          workspaceRoot === null
            ? null
            : applyFleetMirrorCut(
                payload.viewRoot,
                payload.repoId,
                workspaceRoot,
                applied ? "pull" : "command-rejected",
                {
                  taskId,
                  executionId: typeof result.receipt?.executionId === "string" ? result.receipt.executionId : null,
                  kind: "task-docs",
                  ...(conflictCode !== null ? { code: conflictCode } : {}),
                },
              );
        staged.push(...(settle?.conflicts ?? []));
        const worktrees =
          workspaceRoot !== null && settle !== null
            ? await reclaimEdgeTaskWorktrees({ ...payload, workspaceRoot }, settle)
            : null;
        mirror = {
          outcome: settle !== null && settle.outcome === "pull_blocked" ? "pull_blocked" : "applied",
          cut: pulled.current.cut,
          ...(settle !== null && settle.outcome !== "no_view" ? { dirtyPaths: settle.dirtyPaths } : {}),
          ...(worktrees ? { worktrees } : {}),
        };
      } catch (error) {
        consumeKnownError(error);
        mirror = {
          outcome: "pull_failed",

          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const receipt = result.receipt ?? { outcome: result.outcome, code: result.code };
    if (applied) rememberAppliedCut(payload.viewRoot, payload.repoId, payload.nodeId, result.appliedCut);
    const ok = applied && (mirror === null || mirror.outcome !== "pull_blocked");
    return {
      schema: "command-receipt/v2",
      ok,
      command: action.kind,
      outcome: result.outcome,
      opId: result.opId !== "" ? result.opId : `fleet:${opId}`,
      revision: result.revision ?? null,
      canonicalOutcome: result.outcome,
      mirrorOutcome: mirror === null ? "not_pulled" : mirror.outcome,
      ...(ok
        ? {}
        : {
            error: {
              code:
                result.code ??
                (mirror !== null && mirror.outcome === "pull_blocked" ? "pull_blocked" : "fleet_task_rejected"),
            },
          }),
      ...(receipt as Record<string, unknown>),
      ...(result.appliedCut ? { appliedCut: result.appliedCut } : {}),
      fleet: {
        origin: "fleet-edge",
        nodeId: payload.nodeId,
        repoId: payload.repoId,
        commandOpId: opId,
        waitOutcome: result.outcome,
      },
      ...(mirror ? { mirror } : {}),
      ...(staged.length
        ? {
            conflicts: staged.map((conflict) => ({
              conflictId: conflict.conflictId,
              paths: conflict.paths,
              dir: conflict.dir,
              exits: ["resolve", "discard-local", "overwrite-center"],
            })),
          }
        : {}),
    } as Record<string, unknown>;
  });

  // PUSHING_DOCS_AND_TRANSITION: gather this task's dirty registered-harness prose
  // (doc-sync-allowed routes only, inside the canonical task package), upload the
  // bytes as claims, and carry descriptors plus the mirror base cut on the
  // command frame.
  async function attachTaskDocs(): Promise<{
    readonly docChanges: readonly {
      readonly path: string;
      readonly baseBlobSha256: string | null;
      readonly policyId: string;
      readonly candidate: FleetDescriptor;
    }[];
    readonly mirrorBaseCut: { readonly revision: number; readonly headDigest: string };
  } | null> {
    if (taskId === null || workspaceRoot === null || action.kind === "task-create") return null;
    const view = locateFleetMirrorView(payload.viewRoot, payload.repoId);
    if (view === null) return null;
    // The pre-pull base-cache scan over this same view and tree is exactly the
    // dirty-detection the carry set needs; reuse it instead of scanning twice.
    const preScan = cacheFleetMirrorDirtyBases(payload.viewRoot, payload.repoId, workspaceRoot);
    const packagePath = fleetExactTaskPackagePath(view, workspaceRoot, taskId);
    if (packagePath === null || preScan === null) return null;
    const reportPath =
      action.kind === "task-review-execution" ? reviewReportRelativePath(packagePath, String(action.reviewId)) : null;
    const candidates = preScan.changes.filter((change) =>
      action.kind === "task-review-execution" ? change.path === reportPath : change.path.startsWith(`${packagePath}/`),
    );
    if (candidates.length === 0) return null;
    const descriptors = await runFleetUploadClient({
      ...peer,
      timeoutMs: 60_000,
      changes: candidates.map((change) => ({
        path: change.path,
        body: Buffer.from(change.bytes),
        mediaType: change.mediaType,
      })),
    });
    return {
      docChanges: candidates.map((change, index) => ({
        path: change.path,
        baseBlobSha256: change.baseBlobSha256,
        policyId: classifyTextualArtifactPath(change.path)?.policyId ?? DOC_POLICY_ID,
        candidate: descriptors[index]!,
      })),
      mirrorBaseCut: { revision: view.revision, headDigest: view.headDigest },
    };
  }
}
const FLEET_DOC_CONFLICT_CODES = Object.freeze(["mirror_behind_center", "base_blob_changed", "base_ledger_changed"]);
function transientResult(result: Awaited<ReturnType<typeof runFleetTaskCommandClient>>): boolean {
  return (
    result.outcome === "op_rejected" &&
    ["center_closing", "client_disconnected", "lease_state_unavailable", "op_in_flight"].includes(result.code ?? "")
  );
}
function retryable(error: unknown): boolean {
  if (error instanceof FleetRemoteError) return error.retryable;
  if (error instanceof FleetEdgeTaskError) return false;
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code
      : null;
  if (code && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ERR_TLS"].some((value) => code.includes(value)))
    return true;
  return (
    error instanceof Error &&
    /Fleet response timeout|Fleet connection closed|Fleet stream ended mid-frame|session ready expected|task result expected|daemon closed/u.test(
      error.message,
    )
  );
}
/** Full-jitter retry delay shared by every edge loop that waits on the center: 1 ms up to a 250 ms–30 s ceiling. */
export function fleetEdgeBackoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling) + 1;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
