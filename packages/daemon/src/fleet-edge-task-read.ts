// Edge-local repository reads (dec_0C26B97C5B6CEA37101FC0A84D, dec_D8497012F42A999E054D7ADF6A,
// dec_FB7DE6338E7D3D94ED2A4C05A2): the remote-edge cell answers from the view's read model through
// the same query code the center runs, never from a round trip to the center. Freshness is reported
// on every answer; an answer past its budget is still given, marked stale. Only a missing read model
// is unavailable, and that case is the only one that touches the network, once and bounded.
import { watch } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  edgeReadAuthorizationShapeDigest,
  makeEdgeReplicaQueries,
  type EdgeReadFreshness,
  type EdgeReadModelMeta,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { locateFleetMirrorView, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import { isReadDenied, openEdgeReadModel, readHeadConfirmation } from "./fleet/replica-read-model.ts";

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
  readonly writeReadWaitMs?: number;
  readonly minCut?: EdgeReadCut;
  readonly action: Readonly<Record<string, unknown>>;
}

import type { RepositoryReadFrame } from "./protocol/repository-read-frame.ts";

/** One synchronous edge read session: locate, authorize, judge freshness, query, close. */
export function withEdgeReadModel<T>(
  input: {
    readonly viewRoot: string;
    readonly repoId: string;
    readonly principalId: string | undefined;
    readonly maxAgeMs?: number;
    readonly maxLagRevisions?: number;
  },
  read: (projection: TaskProjectionQueries, frame: RepositoryReadFrame, view: FleetMirrorView) => T,
  now: () => number = Date.now,
): T {
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (!view || isReadDenied(view.viewDir))
    throw new EdgeReadError("replica_unavailable", "The edge read model is unavailable.");
  const model = openEdgeReadModel(view, path.join(input.viewRoot, "repos", input.repoId, "cas", "sha256"));
  if (!model) throw new EdgeReadError("replica_unavailable", "The edge read-model bytes are unavailable.");
  try {
    const expected = edgeReadAuthorizationShapeDigest({ repoId: input.repoId, owner: model.meta.authorizationOwner });
    if (
      model.meta.authorizationOwner === null ||
      input.principalId === undefined ||
      input.principalId !== model.meta.authorizationOwner ||
      model.meta.authorizationShapeDigest !== expected
    )
      throw new EdgeReadError("authorization_denied", "The local read model is not authorized for this principal.");
    const fresh = edgeFreshness(view, model.meta, input, now);
    return read(
      makeEdgeReplicaQueries({
        db: model.db,
        cut: { status: "ready", watermark: model.meta.sourceRevision, sourceRevision: model.meta.sourceRevision },
      }),
      {
        cut: { revision: model.meta.sourceRevision, headDigest: view.headDigest },
        freshness: fresh.freshness,
        warning: fresh.warning,
      },
      view,
    );
  } finally {
    model.db.close();
  }
}

class EdgeReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The freshness judgment every edge-local answer reports: budget, lag, and the human warning. */
export function edgeFreshness(
  view: FleetMirrorView,
  meta: EdgeReadModelMeta,
  input: { readonly maxAgeMs?: number; readonly maxLagRevisions?: number },
  now: () => number,
): { readonly freshness: EdgeReadFreshness; readonly warning: string | null } {
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
    freshness: {
      state: stale ? "stale" : "fresh",
      ageMs,
      lagRevisions,
      maxAgeMs,
      maxLagRevisions,
      confirmedAt: confirmation ? new Date(confirmation.confirmedAt).toISOString() : null,
    },
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

function writeReadPendingReceipt(action: Readonly<Record<string, unknown>>, minCut: EdgeReadCut) {
  const command = String(action.kind);
  return {
    schema: "command-receipt/v2",
    command,
    ok: false,
    outcome: "pending",
    code: "write_committed_read_pending",
    appliedCut: minCut,
    error: {
      code: "write_committed_read_pending",
      hint: `The local read model has not reached revision ${minCut.revision} yet.`,
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
 * The CLI edge read: wait for this edge's own last applied write, pull once only when no local read
 * model exists, then answer through the edge cell. A center that cannot be reached never blocks an
 * answer the replica already has.
 */
export async function readEdgeRepository(
  input: EdgeTaskReadInput,
  pull: () => Promise<unknown>,
  readLocal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (input.minCut && !(await waitForMinimumCut(input))) return writeReadPendingReceipt(input.action, input.minCut);
  const command = String(input.action.kind);
  if (!edgeReadModelPresent(input)) {
    try {
      await pull();
    } catch (error) {
      // The center may be unreachable; the receipt below reports the edge state, not the transport.
      consumeKnownError(error);
    }
  }
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (view && isReadDenied(view.viewDir)) return edgeReadDeniedReceipt(command);
  if (!edgeReadModelPresent(input)) return edgeReadUnavailableReceipt(command);
  return readLocal();
}

function edgeReadModelPresent(input: EdgeTaskReadInput): boolean {
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (!view || isReadDenied(view.viewDir)) return false;
  const model = openEdgeReadModel(view, path.join(input.viewRoot, "repos", input.repoId, "cas", "sha256"));
  model?.db.close();
  return model !== null;
}
