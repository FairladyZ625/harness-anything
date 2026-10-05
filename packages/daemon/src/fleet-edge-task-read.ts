// Edge-local `task list` (dec_0C26B97C5B6CEA37101FC0A84D, dec_D8497012F42A999E054D7ADF6A): the answer
// comes from the view's task read model through the same query code the center runs, never from a
// round trip to the center. Freshness is reported on every answer; an answer past its budget is still
// given, marked stale. Only a missing or unusable read model is unavailable, and that case — the one
// where no local answer exists at all — is the only one that touches the network, once and bounded.
import path from "node:path";
import { consumeKnownError, readTaskChildCounts, readTaskIndexRows } from "@harness-anything/kernel";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { isReadDenied, openEdgeTaskReadModel, readHeadConfirmation } from "./fleet/replica-read-model.ts";
import { taskListPayload } from "./repo-cell-task-query.ts";
import { renderTaskIndexPayload } from "./task-index-query.ts";
import { taskListQueryFromPayload } from "./repo-query-payload.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export const DEFAULT_EDGE_READ_MAX_AGE_MS = 60_000;
export const DEFAULT_EDGE_READ_MAX_LAG_REVISIONS = 32;

export interface EdgeTaskReadInput {
  readonly viewRoot: string;
  readonly repoId: string;
  readonly maxAgeMs?: number;
  readonly maxLagRevisions?: number;
  readonly action: Readonly<Record<string, unknown>>;
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
  const model = openEdgeTaskReadModel(view, path.join(input.viewRoot, "repos", input.repoId, "cas", "sha256"));
  if (!model) return null;
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
    const confirmation = readHeadConfirmation(view.viewDir),
      maxAgeMs = input.maxAgeMs ?? DEFAULT_EDGE_READ_MAX_AGE_MS,
      maxLagRevisions = input.maxLagRevisions ?? DEFAULT_EDGE_READ_MAX_LAG_REVISIONS,
      ageMs = confirmation ? Math.max(0, now() - confirmation.confirmedAt) : null,
      lagRevisions = confirmation ? Math.max(0, confirmation.headRevision - model.meta.sourceRevision) : null,
      stale = ageMs === null || lagRevisions === null || ageMs > maxAgeMs || lagRevisions > maxLagRevisions,
      warning = !stale
        ? null
        : ageMs === null
          ? "可能过期：本边缘尚未与中心确认过最新版本。"
          : ageMs > maxAgeMs
            ? `可能过期，已 ${Math.max(1, Math.floor(ageMs / 60_000))} 分钟未连中心。`
            : `可能过期：本地落后中心 ${lagRevisions} 个版本。`;
    // Same top-level shape as the center's task-list receipt: the payload schema is the receipt schema.
    return {
      command: "task-list",
      ok: true,
      outcome: "applied",
      ...payload,
      evidence: JSON.stringify(payload),
      cut: { revision: model.meta.sourceRevision, viewRevision: view.revision, headDigest: view.headDigest },
      freshness: {
        state: stale ? "stale" : "fresh",
        ageMs,
        lagRevisions,
        maxAgeMs,
        maxLagRevisions,
        confirmedAt: confirmation ? new Date(confirmation.confirmedAt).toISOString() : null,
      },
      ...(warning ? { warning } : {}),
      // The human rendering of a center task-list receipt, plus where this answer came from.
      summary: [
        renderTaskIndexPayload(payload),
        `freshness=${stale ? "stale" : "fresh"}  confirmedAt=${confirmation ? new Date(confirmation.confirmedAt).toISOString() : "never"}`,
        warning,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    };
  } finally {
    model.db.close();
  }
}
