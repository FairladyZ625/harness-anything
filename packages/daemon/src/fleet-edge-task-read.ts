// Edge-local `task list` and `task show` (dec_0C26B97C5B6CEA37101FC0A84D, dec_D8497012F42A999E054D7ADF6A):
// the answer comes from the view's read model through the same query code the center runs, never
// from a round trip to the center. Freshness is reported on every answer; an answer past its budget
// is still given, marked stale. Only a missing or unusable read model is unavailable, and that case
// — the one where no local answer exists at all — is the only one that touches the network, once
// and bounded.
import { watch } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  edgeReadAuthorizationShapeDigest,
  makeEdgeReplicaQueries,
  readTaskChildCounts,
  readTaskIndexRows,
  type EdgeReadModelMeta,
} from "@harness-anything/kernel";
import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { isReadDenied, openEdgeReadModel, readHeadConfirmation } from "./fleet/replica-read-model.ts";
import { taskListPayload } from "./repo-cell-task-query.ts";
import { taskShowFromProjection } from "./repo-cell-completion.ts";
import { failed } from "./repo-cell-settlement.ts";
import { renderEvidencePayload } from "./repo-cell-evidence.ts";
import { renderTaskIndexPayload } from "./task-index-query.ts";
import { taskListQueryFromPayload } from "./repo-query-payload.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export const DEFAULT_EDGE_READ_MAX_AGE_MS = 60_000;
export const DEFAULT_EDGE_READ_MAX_LAG_REVISIONS = 32;
export const DEFAULT_WRITE_READ_WAIT_MS = 5_000;

export interface EdgeReadCut {
  readonly revision: number;
  readonly headDigest: string;
}

export interface EdgeTaskReadInput {
  readonly viewRoot: string;
  readonly repoId: string;
  readonly workspaceRoot?: string;
  readonly maxAgeMs?: number;
  readonly maxLagRevisions?: number;
  readonly writeReadWaitMs?: number;
  readonly minCut?: EdgeReadCut;
  readonly action: Readonly<Record<string, unknown>>;
  /** Principal established by the local daemon session, never by the action payload. */
  readonly principalId?: string;
}

class EdgeReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function answerEdgeTaskList(
  input: EdgeTaskReadInput,
  pull: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<Record<string, unknown>> {
  if (input.minCut && !(await waitForMinimumCut(input))) return writeReadPendingReceipt(input.action, input.minCut);
  const local = readLocalTaskList(input, now);
  if (local) return local;
  try {
    await pull();
  } catch (error) {
    // The center may be unreachable; the receipt below reports the edge state, not the transport.
    consumeKnownError(error);
  }
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (view && isReadDenied(view.viewDir))
    return {
      schema: "command-receipt/v2",
      command: "task-list",
      ok: false,
      outcome: "op_rejected",
      code: "authorization_denied",
      error: {
        code: "authorization_denied",
        hint: "The center refused this node's owner repository-read at the last sync; local rows are withheld until a sync is admitted again.",
      },
    };
  return (
    readLocalTaskList(input, now) ?? {
      schema: "command-receipt/v2",
      command: "task-list",
      ok: false,
      outcome: "op_rejected",
      code: "LOCAL_UNAVAILABLE",
      error: {
        code: "LOCAL_UNAVAILABLE",
        hint: "This edge has no usable task read model yet. The center publishes it with each new cut, so it arrives with the first pull after the next write on the center.",
      },
    }
  );
}

function readLocalTaskList(input: EdgeTaskReadInput, now: () => number): Record<string, unknown> | null {
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (!view || isReadDenied(view.viewDir)) return null;
  const model = openEdgeReadModel(view, path.join(input.viewRoot, "repos", input.repoId, "cas", "sha256"));
  if (!model) return null;
  const authorization = authorizeLocalRead(input, model.meta);
  if (authorization) return authorization;
  try {
    const codedError = (code: string, message: string) => new EdgeReadError(code, message),
      action = input.action as RepoTaskAction,
      cut = {
        status: "ready" as const,
        watermark: model.meta.sourceRevision,
        sourceRevision: model.meta.sourceRevision,
      };
    let payload: ReturnType<typeof taskListPayload>["payload"];
    try {
      payload = taskListPayload(
        {
          readTaskIndex: (query = {}) => ({
            schema: "task-index-projection/v1",
            ...cut,
            ...readTaskIndexRows(model.db, { ...query, presentationStatus: true }),
            warnings: [],
          }),
          readTaskChildCounts: (ids) => readTaskChildCounts(model.db, ids),
          rootThreshold: model.meta.rootThreshold,
        },
        taskListQueryFromPayload(input.action, codedError),
        action,
        codedError,
      ).payload;
    } catch (error) {
      if (!(error instanceof EdgeReadError)) throw error;
      return {
        schema: "command-receipt/v2",
        command: "task-list",
        ok: false,
        outcome: "op_rejected",
        code: error.code,
        error: { code: error.code, hint: error.message },
      };
    }
    const fresh = edgeFreshness(view, model.meta, input, now);
    // Same top-level shape as the center's task-list receipt: the payload schema is the receipt schema.
    return {
      command: "task-list",
      ok: true,
      outcome: "applied",
      ...payload,
      evidence: JSON.stringify(payload),
      cut: { revision: model.meta.sourceRevision, viewRevision: view.revision, headDigest: view.headDigest },
      freshness: fresh.envelope,
      ...(fresh.warning ? { warning: fresh.warning } : {}),
      // The human rendering of a center task-list receipt, plus where this answer came from.
      summary: [renderTaskIndexPayload(payload), fresh.line, fresh.warning].filter((line) => line !== null).join("\n"),
    };
  } finally {
    model.db.close();
  }
}

/** The freshness judgment every edge-local answer reports: budget, lag, and the human line. */
export function edgeFreshness(
  view: FleetMirrorView,
  meta: EdgeReadModelMeta,
  input: EdgeTaskReadInput,
  now: () => number,
): {
  readonly envelope: Record<string, unknown>;
  readonly line: string;
  readonly warning: string | null;
} {
  const confirmation = readHeadConfirmation(view.viewDir),
    maxAgeMs = input.maxAgeMs ?? DEFAULT_EDGE_READ_MAX_AGE_MS,
    maxLagRevisions = input.maxLagRevisions ?? DEFAULT_EDGE_READ_MAX_LAG_REVISIONS,
    ageMs = confirmation ? Math.max(0, now() - confirmation.confirmedAt) : null,
    lagRevisions = confirmation ? Math.max(0, confirmation.headRevision - meta.sourceRevision) : null,
    stale = ageMs === null || lagRevisions === null || ageMs > maxAgeMs || lagRevisions > maxLagRevisions,
    warning = !stale
      ? null
      : ageMs === null
        ? "可能过期：本边缘尚未与中心确认过最新版本。"
        : ageMs > maxAgeMs
          ? `可能过期，已 ${Math.max(1, Math.floor(ageMs / 60_000))} 分钟未连中心。`
          : `可能过期：本地落后中心 ${lagRevisions} 个版本。`;
  return {
    envelope: {
      state: stale ? "stale" : "fresh",
      ageMs,
      lagRevisions,
      maxAgeMs,
      maxLagRevisions,
      confirmedAt: confirmation ? new Date(confirmation.confirmedAt).toISOString() : null,
    },
    line: `freshness=${stale ? "stale" : "fresh"}  confirmedAt=${confirmation ? new Date(confirmation.confirmedAt).toISOString() : "never"}`,
    warning,
  };
}

function edgeReadDeniedReceipt(command: string): Record<string, unknown> {
  return {
    schema: "command-receipt/v2",
    command,
    ok: false,
    outcome: "op_rejected",
    code: "authorization_denied",
    error: {
      code: "authorization_denied",
      hint: "The center refused this node's owner repository-read at the last sync; local rows are withheld until a sync is admitted again.",
    },
  };
}

function edgeReadUnavailableReceipt(command: string): Record<string, unknown> {
  return {
    schema: "command-receipt/v2",
    command,
    ok: false,
    outcome: "op_rejected",
    code: "LOCAL_UNAVAILABLE",
    error: {
      code: "LOCAL_UNAVAILABLE",
      hint: "This edge has no usable read model yet. The center publishes it with each new cut, so it arrives with the first pull after the next write on the center.",
    },
  };
}

/** Edge-local `task show`: the center's own assembly (taskShowFromProjection) over the replica tables. */
export async function answerEdgeTaskShow(
  input: EdgeTaskReadInput,
  pull: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<Record<string, unknown>> {
  if (input.minCut && !(await waitForMinimumCut(input))) return writeReadPendingReceipt(input.action, input.minCut);
  const local = readLocalTaskShow(input, now);
  if (local) return local;
  try {
    await pull();
  } catch (error) {
    // The center may be unreachable; the receipt below reports the edge state, not the transport.
    consumeKnownError(error);
  }
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (view && isReadDenied(view.viewDir)) return edgeReadDeniedReceipt("task-show");
  return readLocalTaskShow(input, now) ?? edgeReadUnavailableReceipt("task-show");
}

function writeReadPendingReceipt(action: Readonly<Record<string, unknown>>, minCut: EdgeReadCut) {
  const command = action.kind === "task-list" ? "task-list" : "task-show";
  return {
    schema: "command-receipt/v2",
    command,
    ok: false,
    outcome: "pending",
    code: "write_committed_read_pending",
    appliedCut: minCut,
    error: {
      code: "write_committed_read_pending",
      hint: `The local task read model has not reached revision ${minCut.revision} yet.`,
    },
  };
}

async function waitForMinimumCut(input: EdgeTaskReadInput): Promise<boolean> {
  const target = input.minCut!;
  // A denied view ends the wait: the denial, not a pending write, is the read's answer.
  const reached = (): boolean => {
    const view = locateFleetMirrorView(input.viewRoot, input.repoId);
    return Boolean(
      view &&
        (isReadDenied(view.viewDir) ||
          view.revision > target.revision ||
          (view.revision === target.revision && view.headDigest === target.headDigest)),
    );
  };
  if (reached()) return true;
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (!view) return false;
  const timeoutMs = Math.max(0, input.writeReadWaitMs ?? DEFAULT_WRITE_READ_WAIT_MS);
  if (timeoutMs === 0) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const watcher = watch(view.viewDir, () => {
      if (reached()) finish(true);
    });
    const timer = setTimeout(() => finish(reached()), timeoutMs);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      resolve(value);
    };
    watcher.on("error", () => finish(reached()));
    if (reached()) finish(true);
  });
}

/**
 * The write path's task-show: it reads to authorize a submission, so it pulls first — the same
 * freshness the old center round trip gave — and then answers from the local replica.
 */
export async function answerFreshEdgeTaskShow(
  input: EdgeTaskReadInput,
  pull: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<Record<string, unknown>> {
  try {
    await pull();
  } catch (error) {
    // The receipt below reports the edge state, not the transport.
    consumeKnownError(error);
  }
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (view && isReadDenied(view.viewDir)) return edgeReadDeniedReceipt("task-show");
  return readLocalTaskShow(input, now) ?? edgeReadUnavailableReceipt("task-show");
}

/** The center's human rendering of a task-show payload; a failed read carries prose, not a payload. */
function evidenceSummary(evidence: string | undefined): string {
  if (typeof evidence !== "string") return "";
  try {
    return renderEvidencePayload(JSON.parse(evidence));
  } catch (error) {
    consumeKnownError(error);
    return "";
  }
}

function readLocalTaskShow(input: EdgeTaskReadInput, now: () => number): Record<string, unknown> | null {
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (!view || isReadDenied(view.viewDir)) return null;
  const model = openEdgeReadModel(view, path.join(input.viewRoot, "repos", input.repoId, "cas", "sha256"));
  if (!model) return null;
  const authorization = authorizeLocalRead(input, model.meta);
  if (authorization) return authorization;
  const action = input.action as { readonly taskId?: unknown };
  if (typeof action.taskId !== "string" || action.taskId === "")
    return {
      schema: "command-receipt/v2",
      command: "task-show",
      ok: false,
      outcome: "op_rejected",
      code: "missing_field",
      error: { code: "missing_field", hint: "Run ha task show <task-id>." },
    };
  try {
    // task-show answers with receipts on every path; an assembly error settles the same way.
    const receipt = taskShowFromProjection(
        input.workspaceRoot ?? input.viewRoot,
        makeEdgeReplicaQueries({
          db: model.db,
          cut: {
            status: "ready",
            watermark: model.meta.sourceRevision,
            sourceRevision: model.meta.sourceRevision,
          },
        }),
        action.taskId,
      ),
      fresh = edgeFreshness(view, model.meta, input, now);
    return {
      schema: "command-receipt/v2",
      command: "task-show",
      ok: receipt.outcome === "applied",
      ...receipt,
      cut: { revision: model.meta.sourceRevision, viewRevision: view.revision, headDigest: view.headDigest },
      freshness: fresh.envelope,
      ...(fresh.warning ? { warning: fresh.warning } : {}),
      summary: [evidenceSummary(receipt.evidence), fresh.line, fresh.warning]
        .filter((line) => line !== null && line !== "")
        .join("\n"),
    };
  } catch (error) {
    consumeKnownError(error);
    return {
      schema: "command-receipt/v2",
      command: "task-show",
      ok: false,
      ...failed(`read:${String(action.taskId)}`, error),
    };
  } finally {
    model.db.close();
  }
}

function authorizeLocalRead(
  input: EdgeTaskReadInput,
  meta: EdgeReadModelMeta & { readonly authorizationOwner: string | null; readonly authorizationShapeDigest: string },
): Record<string, unknown> | null {
  const expected = edgeReadAuthorizationShapeDigest({ repoId: input.repoId, owner: meta.authorizationOwner });
  if (
    meta.authorizationShapeDigest !== "" &&
    (meta.authorizationOwner === null ||
      input.principalId === undefined ||
      input.principalId !== meta.authorizationOwner ||
      meta.authorizationShapeDigest !== expected)
  )
    return {
      schema: "command-receipt/v2",
      command: input.action.kind === "task-list" ? "task-list" : "task-show",
      ok: false,
      outcome: "op_rejected",
      code: "authorization_denied",
      error: { code: "authorization_denied", hint: "The local read model is not authorized for this principal." },
    };
  return null;
}
