import { createHash, randomBytes } from "node:crypto";
import {
  isNativeExecution,
  taskLifecycleWritePlan,
  type CanonicalContentBlob,
  type CanonicalWriteBundle,
  type ExecutionV1,
  type LeaseV1,
  type TaskV2,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import {
  executionStewardshipEpoch,
  type ExecutionWipCheckpointV1,
} from "@harness-anything/kernel/internal/domain/execution.ts";
import type {
  ExecutionStewardshipTransferredEvent,
  ExecutionWipCheckpointedEvent,
} from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
import {
  assertExecutionStewardshipFence,
  classifyPeerIntentRiskTier,
  compilePeerRequestAnswered,
  compilePeerRequestClaimed,
  compilePeerRequestDone,
  compilePeerRequestOpened,
  compilePeerRequestPromoted,
  compilePeerRequestRejected,
  DEFAULT_OFFLINE_TAKEOVER_THRESHOLD_MS,
  evaluateOfflineTakeoverAdmission,
  evaluatePeerExecutionCeiling,
  isPeerFrameCausallyReady,
  matchesPeerWatchFilter,
  peerRequestKinds,
  reducePeerRequestEvent,
  verifyPeerSenderIdentity,
  type ContinuationPacket,
  type PeerAttachment,
  type PeerRequestEventV1,
  type PeerRequestInput,
  type PeerRequestKind,
  type PeerRequestState,
  type PeerRequestV1,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import {
  inboxDedupeKey,
  type InboxEventPayloads,
  type InboxItem,
} from "@harness-anything/kernel/internal/domain/inbox.ts";
import { compileInboxEnqueuedEvent } from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { reject } from "@harness-anything/application/internal/commands/entity-action-write-helpers.ts";
import { applyPreparedTaskCreate, prepareTaskCreateAt, type PreparedTaskCreate } from "./repo-cell-task-create.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";
import {
  materializeHandoffBundle,
  prepareHandoffBundle,
  type MaterializedHandoffBundle,
  type PreparedHandoffBundle,
} from "./peer-handoff-bundle.ts";

const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const DEFAULT_HANDOFF_LEASE_TTL_MS = 30 * 60_000;
const STEWARD_FENCED_TASK_ACTIONS = new Set([
  "task-start",
  "task-submit",
  "task-progress-append",
  "task-release",
  "task-annotate",
  "task-attest",
  "task-declare-executor",
  "task-settle",
  "task-respond-review",
]);

export interface PeerActionExecutionOptions {
  readonly preparedHandoff?: PreparedHandoffBundle;
  readonly fleetStreamConnected?: boolean;
}

function activeExecutionForTask(
  cell: RepoCellOperationalContext,
  taskId: string,
): { readonly task: TaskV2; readonly execution: ExecutionV1; readonly snapshotLease: LeaseV1 | null } {
  const read = cell.projection.read(taskId);
  const task = read.snapshot.task;
  if (!task) reject("entity_not_found", `Task ${taskId} does not exist.`);
  const execution = read.snapshot.executions.findLast(
    (entry): entry is ExecutionV1 =>
      isNativeExecution(entry) &&
      entry.iteration === task!.iteration &&
      (entry.state === "active" || entry.state === "changes_requested"),
  );
  if (!execution) {
    reject(
      "invalid_transition",
      `Task ${taskId} has no active Execution on iteration ${String(task!.iteration)} to transfer or checkpoint.`,
    );
  }
  return { task: task!, execution: execution!, snapshotLease: read.snapshot.lease };
}

function buildTaskEventBundle(
  event: ExecutionStewardshipTransferredEvent | ExecutionWipCheckpointedEvent,
): CanonicalWriteBundle {
  return {
    event,
    plan: taskLifecycleWritePlan(event),
    blobs: [],
  };
}

/** Reject stale-epoch or superseded-steward writes with structured `execution_handed_off`. */
export function enforceTaskActionStewardshipFence(
  cell: Pick<RepoCellOperationalContext, "projection">,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): void {
  if (!STEWARD_FENCED_TASK_ACTIONS.has(action.kind)) return;
  const taskId = typeof action.taskId === "string" && action.taskId.trim().length > 0 ? action.taskId.trim() : null;
  if (!taskId) return;
  const read = cell.projection.read(taskId);
  const task = read.snapshot.task;
  if (!task) return;
  const requestedExecId =
    typeof action.executionId === "string" && action.executionId.trim().length > 0 ? action.executionId.trim() : null;
  const targetExecution = read.snapshot.executions.findLast(
    (entry): entry is ExecutionV1 =>
      isNativeExecution(entry) &&
      (requestedExecId !== null
        ? entry.executionId === requestedExecId
        : entry.iteration === task.iteration && (entry.state === "active" || entry.state === "changes_requested")),
  );
  if (!targetExecution) return;
  const expectedStewardshipEpoch = typeof action.stewardshipEpoch === "number" ? action.stewardshipEpoch : undefined;
  const actingNodeId =
    typeof action.nodeId === "string" && action.nodeId.trim().length > 0
      ? action.nodeId.trim()
      : binding.source !== "local" && typeof binding.source === "object" && "nodeId" in binding.source
        ? String(binding.source.nodeId)
        : undefined;
  const verdict = assertExecutionStewardshipFence({
    executionId: targetExecution.executionId,
    currentStewardshipEpoch: executionStewardshipEpoch(targetExecution),
    currentStewardPersonId: targetExecution.actor.principal.personId,
    ...(targetExecution.stewardNodeId ? { currentStewardNodeId: targetExecution.stewardNodeId } : {}),
    actingPersonId: binding.actor.principal.personId,
    ...(actingNodeId ? { actingNodeId } : {}),
    ...(expectedStewardshipEpoch !== undefined ? { expectedStewardshipEpoch } : {}),
  });
  if (!verdict.ok) reject(verdict.errorCode, verdict.message);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) reject("invalid_field", `${label} is required.`);
  return (value as string).trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function makePeerId(repoId: string, personId: string, idempotencyKey?: string): string {
  return idempotencyKey
    ? `peer_${createHash("sha256").update(`${repoId}:${personId}:${idempotencyKey}`).digest("hex").slice(0, 24)}`
    : `peer_${randomBytes(12).toString("hex")}`;
}

function buildInboxEnqueueBundle(input: {
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: RepoCellBinding["actor"];
  readonly source: RepoCellBinding["source"];
  readonly occurredAt: string;
  readonly payload: InboxEventPayloads["inbox_item_enqueued"];
}): CanonicalWriteBundle {
  const event = compileInboxEnqueuedEvent({
    eventId: `event-${input.opId}`,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  });
  return {
    event,
    plan: canonicalEventWritePlan(event, "inbox", input.payload.inboxId),
    blobs: [],
  };
}

function buildPeerEventBundle(
  event: PeerRequestEventV1,
  requestId: string,
  blobs: readonly CanonicalContentBlob[] = [],
): CanonicalWriteBundle {
  return {
    event,
    plan: canonicalEventWritePlan(event, "peer-request", requestId),
    blobs,
  };
}

function bareSha256(sha: string): string {
  return sha.startsWith("sha256:") ? sha.slice("sha256:".length) : sha;
}

function hasLocalBlob(cell: RepoCellOperationalContext, sha: string): boolean {
  return cell.store.readContentBlob(bareSha256(sha)) !== null;
}

function findPeerRequest(cell: RepoCellOperationalContext, requestId: string): PeerRequestV1 {
  const read = cell.projection.readPeerRequests({ by: "id", requestId });
  if (read.status !== "ready" || read.requests.length === 0) {
    reject("entity_not_found", `PeerRequest ${requestId} does not exist.`);
  }
  return read.requests[0]!;
}

function commitBatch(
  cell: RepoCellOperationalContext,
  batch: readonly CanonicalWriteBundle[],
  prepared?: PreparedTaskCreate,
): void {
  const final = batch[batch.length - 1]!;
  cell.store.append({ ...final, preceding: batch.slice(0, -1) });
  for (const item of batch) {
    if (prepared && item === prepared.compiled) applyPreparedTaskCreate(cell, prepared);
    else cell.projection.apply(item.event, item.plan);
  }
}

export function evaluatePeerWatchOnce(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
): WriteReceiptDraft {
  const personId = binding.actor.principal.personId;
  const cut = cell.projection.readCut();
  const inboxId = `person:${personId}`;
  const filter = {
    ...(optionalString(action.replyTo) ? { replyTo: optionalString(action.replyTo) } : {}),
    ...(optionalString(action.workId) ? { workId: optionalString(action.workId) } : {}),
    ...(optionalString(action.lane) ? { lane: optionalString(action.lane) } : {}),
  };
  const effectiveFilter =
    filter.replyTo === undefined && filter.workId === undefined && filter.lane === undefined
      ? { lane: "default" }
      : filter;
  const read = cell.projection.readInbox({
    by: "queue",
    status: "pending",
    consumerKind: "interactive_watch",
    inboxId,
    limit: 200,
  });
  const items = read.status === "ready" ? read.items : [];
  const matching: InboxItem[] = [];
  for (const item of items) {
    if (item.source !== "peer_request" && item.source !== "peer_reply") continue;
    if (
      !matchesPeerWatchFilter(
        {
          source: item.source,
          ...(item.correlationId ? { correlationId: item.correlationId } : {}),
          ...(item.workId ? { workId: item.workId } : {}),
          ...(item.lane ? { lane: item.lane } : {}),
        },
        effectiveFilter,
      )
    )
      continue;
    matching.push(item);
    const ready = isPeerFrameCausallyReady({
      minRevision: item.minRevision,
      requiredBlobSha256s: item.requiredBlobSha256s,
      localWatermark: cut.watermark,
      hasLocalBlob: (sha) => hasLocalBlob(cell, sha),
    });
    if (ready) {
      const reqRead = cell.projection.readPeerRequests({ by: "id", requestId: item.sourceRef });
      const request = reqRead.status === "ready" ? (reqRead.requests[0] ?? null) : null;
      return cell.readResult(
        opId,
        { matched: true, watermark: cut.watermark, item, request },
        cut.sourceRevision,
        null,
      );
    }
  }
  return cell.readResult(
    opId,
    { matched: false, watermark: cut.watermark, pendingCount: matching.length, item: null, request: null },
    cut.sourceRevision,
    null,
  );
}

export function runPeerAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
  options?: PeerActionExecutionOptions,
): WriteReceiptDraft {
  const personId = binding.actor.principal.personId;

  if (action.kind === "peer-watch") {
    return evaluatePeerWatchOnce(cell, action, binding, opId);
  }

  if (action.kind === "peer-inbox") {
    const cut = cell.projection.readCut();
    const sent = action.sent === true;
    const reqRead = cell.projection.readPeerRequests({
      by: "list",
      ...(sent ? { senderPersonId: personId } : { recipientPersonId: personId }),
      ...(optionalString(action.state) ? { state: optionalString(action.state) as PeerRequestState } : {}),
      ...(optionalString(action.requestKind) ? { kind: optionalString(action.requestKind) as PeerRequestKind } : {}),
      ...(optionalString(action.workId) ? { workId: optionalString(action.workId) } : {}),
      ...(optionalString(action.lane) ? { lane: optionalString(action.lane) } : {}),
      ...(typeof action.limit === "number" ? { limit: action.limit } : {}),
    });
    const inboxRead = cell.projection.readInbox({
      by: "queue",
      status: "pending",
      consumerKind: "interactive_watch",
      inboxId: `person:${personId}`,
      ...(typeof action.limit === "number" ? { limit: action.limit } : {}),
    });
    return cell.readResult(
      opId,
      {
        requests: reqRead.status === "ready" ? reqRead.requests : [],
        inboxItems: inboxRead.status === "ready" ? inboxRead.items : [],
        watermark: cut.watermark,
      },
      cut.sourceRevision,
      null,
    );
  }

  const head = cell.store.readHead()?.revision ?? 0;
  const now = cell.now();

  if (action.kind === "peer-ask" || action.kind === "peer-handoff") {
    if (action.fleetStreamConnected === false || options?.fleetStreamConnected === false) {
      reject(
        "peer_replication_disconnected",
        "Fleet replication stream (7545) is disconnected; peer ask/handoff fail closed until reconnected.",
      );
    }
    const claimedSender = optionalString(action.fromPersonId) ?? personId;
    const identity = verifyPeerSenderIdentity({ claimedPersonId: claimedSender, authenticatedPersonId: personId });
    if (!identity.valid) {
      reject(identity.errorCode, `Sender ${claimedSender} does not match authenticated principal ${personId}.`);
    }
    const toPersonId = requiredString(action.toPersonId, "--to");
    const isHandoff = action.kind === "peer-handoff";
    const kind = (isHandoff ? "handoff" : (optionalString(action.requestKind) ?? "question")) as PeerRequestKind;
    if (!peerRequestKinds.includes(kind)) reject("invalid_field", `Unsupported peer request kind: ${kind}.`);

    const workId = optionalString(action.workId);
    const lane = optionalString(action.lane);
    const nodeId = optionalString(action.nodeId) ?? cell.input.repoId;
    const idempotencyKey = optionalString(action.idempotencyKey);
    const requestId = makePeerId(cell.input.repoId, personId, idempotencyKey);

    let summary: string;
    let claimText: string;
    let requestedAction: string;
    let anchorRef = optionalString(action.anchorRef);
    let continuationPacket: ContinuationPacket | undefined;
    const attachments: PeerAttachment[] = [];
    const blobs: CanonicalContentBlob[] = [];
    let releasedLeaseId: string | null = null;

    if (isHandoff) {
      const targetId = requiredString(action.targetId, "<target-id>");
      anchorRef = anchorRef ?? `task/${targetId}`;
      const bundle = options?.preparedHandoff;
      const wipCommitSha =
        bundle?.wipCommitSha ?? optionalString(action.wipCommitSha) ?? "0000000000000000000000000000000000000000";
      if (bundle?.bundleBlob && bundle.bundleSha256 && bundle.bundleSize !== undefined) {
        attachments.push({
          sha256: bundle.bundleSha256,
          mediaType: "application/x-git-bundle",
          access: "read-only",
          size: bundle.bundleSize,
        });
        blobs.push(bundle.bundleBlob);
      }
      const dispatches = cell.projection.readRuntimeDispatchesByTaskIds([targetId]);
      const verifiedReceipts = Array.isArray(action.verifiedReceipts)
        ? (action.verifiedReceipts as string[])
        : dispatches.map((d) => d.payload.dispatchId).slice(-8);
      const inFlightDispatches = Array.isArray(action.inFlightDispatches)
        ? (action.inFlightDispatches as string[])
        : [];
      const nextAction = optionalString(action.nextAction) ?? `Resume ${anchorRef} from ${wipCommitSha.slice(0, 12)}`;
      const blockingGate = optionalString(action.blockingGate) ?? null;
      continuationPacket = {
        anchorRef,
        wipCommitSha,
        ...(bundle?.bundleSha256 ? { wipBundleBlobSha256: bundle.bundleSha256 } : {}),
        ...(typeof action.prNumber === "number" ? { prNumber: action.prNumber } : {}),
        verifiedReceipts,
        inFlightDispatches,
        blockingGate,
        nextAction,
      };
      summary = optionalString(action.summary) ?? `Handoff ${anchorRef} (${wipCommitSha.slice(0, 12)})`;
      claimText = `Handing off ${anchorRef} at commit ${wipCommitSha}`;
      requestedAction = nextAction;

      const activeLease = cell.projection.currentLease(targetId, now);
      if (activeLease) {
        cell.projection.releaseLease(activeLease);
        releasedLeaseId = activeLease.executionId;
      }
    } else {
      summary = requiredString(action.summary, "--summary");
      claimText = requiredString(action.claim, "--claim");
      requestedAction = requiredString(action.requestedAction, "--action");
    }

    const requestInput: PeerRequestInput = {
      requestId,
      from: {
        personId: claimedSender,
        nodeId,
        ...(optionalString(action.sessionHint) ? { sessionHint: optionalString(action.sessionHint) } : {}),
      },
      to: {
        personId: toPersonId,
        ...(workId ? { workId } : {}),
        ...(lane ? { lane } : {}),
      },
      kind,
      ...(anchorRef ? { anchorRef } : {}),
      summary,
      structuredBody: {
        claim: claimText,
        ...(optionalString(action.rootCause) ? { rootCause: optionalString(action.rootCause) } : {}),
        requestedAction,
        ...(optionalString(action.verification) ? { verification: optionalString(action.verification) } : {}),
      },
      attachments,
      ...(continuationPacket ? { continuationPacket } : {}),
    };

    const openedRevision = head + 1;
    const openEvent = compilePeerRequestOpened(
      {
        eventId: `event-${opId}-open`,
        workspaceRevision: openedRevision,
        opId: `${opId}-open`,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
      },
      { requestRevision: 1, request: requestInput },
    );
    const snapshot = reducePeerRequestEvent(null, openEvent);
    const inboxRevision = head + 2;
    const requiredBlobSha256s = attachments.map((a) => bareSha256(a.sha256));
    const inboxBundle = buildInboxEnqueueBundle({
      opId,
      workspaceRevision: inboxRevision,
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        inboxId: `person:${toPersonId}`,
        itemId: `peer-req-${requestId}`,
        source: "peer_request",
        sourceRef: requestId,
        sourceEpoch: 1,
        dedupeKey: inboxDedupeKey({ source: "peer_request", sourceRef: requestId, sourceEpoch: 1 }),
        admission: "dispatchable",
        consumerKind: "interactive_watch",
        taskId: null,
        agentId: null,
        senderPersonId: personId,
        workId: workId ?? null,
        lane: lane ?? null,
        correlationId: requestId,
        minRevision: inboxRevision,
        requiredBlobSha256s,
        summary,
        enqueuedAt: now,
      },
    });
    const batch = [buildPeerEventBundle(openEvent, requestId, blobs), inboxBundle];
    commitBatch(cell, batch);
    return {
      ...cell.readResult(
        opId,
        {
          request: snapshot,
          inboxId: `person:${toPersonId}`,
          minRevision: inboxRevision,
          ...(releasedLeaseId ? { releasedLeaseExecutionId: releasedLeaseId } : {}),
        },
        inboxRevision,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  if (action.kind === "peer-reply") {
    const requestId = requiredString(action.requestId, "<request-id>");
    const current = findPeerRequest(cell, requestId);
    if (current.to.personId !== personId) {
      reject("peer_request_recipient_mismatch", `Only ${current.to.personId} may reply to ${requestId}.`);
    }

    const operation = optionalString(action.operation);
    if (operation !== undefined) {
      const tier = classifyPeerIntentRiskTier(operation);
      const verdict = evaluatePeerExecutionCeiling(tier, {
        preflightPassed: action.preflightPassed === true,
        humanConfirmed: action.humanConfirmed === true,
      });
      if ("errorCode" in verdict && verdict.errorCode) {
        reject(
          verdict.errorCode,
          `Tier-A ${verdict.tier} ceiling denied operation "${operation}": ${verdict.ceiling}.`,
        );
      }
      if (verdict.ceiling === "draft_only" && action.draftOnly !== true) {
        reject(
          "peer_execution_ceiling_draft_only",
          `Tier-A L2 operation "${operation}" is draft-only; re-run with --draft-only to emit a draft without executing.`,
        );
      }
    }

    const batch: CanonicalWriteBundle[] = [];
    let state: PeerRequestV1 = current;
    let nextWorkspaceRev = head;
    const claimActive =
      state.state === "CLAIMED" && state.claim !== null && Date.parse(state.claim.expiresAt) > Date.parse(now);
    if (!claimActive) {
      nextWorkspaceRev += 1;
      const expiresAt = new Date(Date.parse(now) + DEFAULT_CLAIM_LEASE_MS).toISOString();
      const claimEvent = compilePeerRequestClaimed(
        {
          eventId: `event-${opId}-claim`,
          workspaceRevision: nextWorkspaceRev,
          opId: `${opId}-claim`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        { requestId, requestRevision: state.revision + 1, expiresAt },
      );
      state = reducePeerRequestEvent(state, claimEvent);
      batch.push(buildPeerEventBundle(claimEvent, requestId));
    }

    const outcome = optionalString(action.outcome) ?? "answered";
    nextWorkspaceRev += 1;
    let terminalEvent: PeerRequestEventV1;
    if (outcome === "done") {
      terminalEvent = compilePeerRequestDone(
        {
          eventId: `event-${opId}-done`,
          workspaceRevision: nextWorkspaceRev,
          opId: `${opId}-done`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        { requestId, requestRevision: state.revision + 1, claimId: state.claim!.claimId },
      );
    } else if (outcome === "rejected") {
      const reason = requiredString(action.reason, "--reason");
      terminalEvent = compilePeerRequestRejected(
        {
          eventId: `event-${opId}-reject`,
          workspaceRevision: nextWorkspaceRev,
          opId: `${opId}-reject`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        { requestId, requestRevision: state.revision + 1, claimId: state.claim!.claimId, reason },
      );
    } else {
      const replyClaim = requiredString(action.claim, "--claim");
      const replyAction = requiredString(action.requestedAction, "--action");
      terminalEvent = compilePeerRequestAnswered(
        {
          eventId: `event-${opId}-answer`,
          workspaceRevision: nextWorkspaceRev,
          opId: `${opId}-answer`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        {
          requestId,
          requestRevision: state.revision + 1,
          claimId: state.claim!.claimId,
          reply: {
            structuredBody: {
              claim: replyClaim,
              ...(optionalString(action.rootCause) ? { rootCause: optionalString(action.rootCause) } : {}),
              requestedAction: replyAction,
              ...(optionalString(action.verification) ? { verification: optionalString(action.verification) } : {}),
            },
            attachments: [],
            minRevision: nextWorkspaceRev + 1,
          },
        },
      );
    }
    state = reducePeerRequestEvent(state, terminalEvent);
    batch.push(buildPeerEventBundle(terminalEvent, requestId));

    const inboxRevision = nextWorkspaceRev + 1;
    batch.push(
      buildInboxEnqueueBundle({
        opId,
        workspaceRevision: inboxRevision,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
        payload: {
          inboxId: `person:${current.from.personId}`,
          itemId: `peer-reply-${requestId}-${state.revision}`,
          source: "peer_reply",
          sourceRef: requestId,
          sourceEpoch: state.revision,
          dedupeKey: inboxDedupeKey({ source: "peer_reply", sourceRef: requestId, sourceEpoch: state.revision }),
          admission: "dispatchable",
          consumerKind: "interactive_watch",
          taskId: null,
          agentId: null,
          senderPersonId: personId,
          workId: current.to.workId ?? null,
          lane: current.to.lane ?? null,
          correlationId: requestId,
          minRevision: inboxRevision,
          requiredBlobSha256s: [],
          summary: `Reply (${state.state}) for ${requestId}: ${current.summary}`.slice(0, 1024),
          enqueuedAt: now,
        },
      }),
    );

    commitBatch(cell, batch);
    return {
      ...cell.readResult(
        opId,
        { request: state, replyInboxId: `person:${current.from.personId}`, minRevision: inboxRevision },
        inboxRevision,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  if (action.kind === "peer-promote") {
    const requestId = requiredString(action.requestId, "<request-id>");
    const work = requiredString(action.work, "--work");
    const current = findPeerRequest(cell, requestId);
    if (current.to.personId !== personId) {
      reject("peer_request_recipient_mismatch", `Only ${current.to.personId} may promote ${requestId}.`);
    }
    const root = cell.projection.read(work).snapshot.task;
    if (!root || root.taskClass !== "work") {
      reject("invalid_field", "--work must identify an existing work root task.");
    }

    const batch: CanonicalWriteBundle[] = [];
    let state: PeerRequestV1 = current;
    let nextWorkspaceRev = head;
    const claimActive =
      state.state === "CLAIMED" && state.claim !== null && Date.parse(state.claim.expiresAt) > Date.parse(now);
    if (!claimActive) {
      nextWorkspaceRev += 1;
      const expiresAt = new Date(Date.parse(now) + DEFAULT_CLAIM_LEASE_MS).toISOString();
      const claimEvent = compilePeerRequestClaimed(
        {
          eventId: `event-${opId}-claim`,
          workspaceRevision: nextWorkspaceRev,
          opId: `${opId}-claim`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        { requestId, requestRevision: state.revision + 1, expiresAt },
      );
      state = reducePeerRequestEvent(state, claimEvent);
      batch.push(buildPeerEventBundle(claimEvent, requestId));
    }

    nextWorkspaceRev += 1;
    const taskAction = cell.taskCreateAction(cell.rootDir, {
      kind: "task-create",
      title: optionalString(action.title) ?? current.summary,
      parentTaskId: work,
      idempotencyKey: `peer-promote:${requestId}`,
    });
    const prepared = prepareTaskCreateAt(cell, taskAction, binding, { workspaceRevision: nextWorkspaceRev });
    if (!("compiled" in prepared)) return prepared;
    batch.push(prepared.compiled);

    nextWorkspaceRev += 1;
    const promoteEvent = compilePeerRequestPromoted(
      {
        eventId: `event-${opId}`,
        workspaceRevision: nextWorkspaceRev,
        opId,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
      },
      {
        requestId,
        requestRevision: state.revision + 1,
        claimId: state.claim!.claimId,
        promotedTaskId: prepared.fields.taskId,
      },
    );
    state = reducePeerRequestEvent(state, promoteEvent);
    batch.push(buildPeerEventBundle(promoteEvent, requestId));

    commitBatch(cell, batch, prepared);
    return {
      ...cell.readResult(
        opId,
        { request: state, promotedTaskId: prepared.fields.taskId, taskRef: `task/${prepared.fields.taskId}` },
        nextWorkspaceRev,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  if (action.kind === "peer-accept-handoff") {
    if (action.fleetStreamConnected === false || options?.fleetStreamConnected === false) {
      reject(
        "peer_replication_disconnected",
        "Fleet replication stream (7545) is disconnected; peer accept-handoff fails closed until reconnected.",
      );
    }
    const requestId = requiredString(action.requestId, "<request-id>");
    const current = findPeerRequest(cell, requestId);
    if (current.kind !== "handoff") {
      reject("peer_request_transition_invalid", `PeerRequest ${requestId} is kind=${current.kind}, not handoff.`);
    }
    if (current.to.personId !== personId) {
      reject("peer_request_recipient_mismatch", `Only ${current.to.personId} may accept handoff ${requestId}.`);
    }
    if (current.state !== "OPEN" && current.state !== "CLAIMED") {
      reject("peer_request_transition_invalid", `PeerRequest ${requestId} is already ${current.state}.`);
    }
    const rawAnchor = current.continuationPacket?.anchorRef ?? current.anchorRef;
    const taskId = rawAnchor?.startsWith("task/") ? rawAnchor.slice("task/".length) : rawAnchor;
    if (!taskId) {
      reject("invalid_field", `Handoff PeerRequest ${requestId} is missing a task anchorRef.`);
    }
    const { task, execution, snapshotLease } = activeExecutionForTask(cell, taskId!);
    const previousEpoch = executionStewardshipEpoch(execution);
    const nextEpoch = previousEpoch + 1;
    const stewardNodeId = optionalString(action.nodeId) ?? cell.input.repoId;
    const ttlMs =
      typeof action.ttlMs === "number" && Number.isSafeInteger(action.ttlMs) && action.ttlMs >= 1_000
        ? action.ttlMs
        : DEFAULT_HANDOFF_LEASE_TTL_MS;
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const liveLease = cell.projection.currentLease(taskId!, now) ?? snapshotLease;
    const previousHolder = liveLease
      ? { taskId: taskId!, executionId: liveLease.executionId, actor: liveLease.actor, source: liveLease.source }
      : null;
    const nextLeaseVersion = (liveLease?.version ?? 0) + 1;
    const packet = current.continuationPacket;
    const nextWipCheckpoint: ExecutionWipCheckpointV1 | undefined = packet?.wipCommitSha
      ? {
          commitSha: packet.wipCommitSha,
          ...(packet.wipBundleBlobSha256 ? { bundleBlobSha256: packet.wipBundleBlobSha256 } : {}),
          receiptRefs: [...packet.verifiedReceipts],
          recordedAt: now,
          stewardshipEpoch: nextEpoch,
        }
      : execution.wipCheckpoint;
    const nextExecution: ExecutionV1 = {
      ...execution,
      actor: binding.actor,
      stewardshipEpoch: nextEpoch,
      stewardNodeId,
      ...(nextWipCheckpoint ? { wipCheckpoint: nextWipCheckpoint } : {}),
    };
    const nextLease: LeaseV1 = {
      schema: "lease/v1",
      taskId: taskId!,
      executionId: execution.executionId,
      actor: binding.actor,
      source: binding.source,
      phase: "held",
      expiresAt,
      ttlMs,
      version: nextLeaseVersion,
      stewardshipEpoch: nextEpoch,
    };
    const nextTask: TaskV2 = task.status === "active" ? task : { ...task, status: "active" };

    const batch: CanonicalWriteBundle[] = [];
    let nextWorkspaceRev = head + 1;
    const transferEvent: ExecutionStewardshipTransferredEvent = {
      schema: "task-event/v1",
      eventId: `event-${opId}-transfer`,
      workspaceRevision: nextWorkspaceRev,
      opId: `${opId}-transfer`,
      taskId: taskId!,
      type: "execution_stewardship_transferred",
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        task: nextTask,
        execution: nextExecution,
        lease: nextLease,
        previousHolder,
        previousStewardshipEpoch: previousEpoch,
        stewardshipEpoch: nextEpoch,
        mode: "accept_handoff",
        peerRequestId: requestId,
        reason: `Accepted peer handoff ${requestId} from ${current.from.personId}`,
        leaseExpiresAt: expiresAt,
        documentClaims: [],
      },
    };
    batch.push(buildTaskEventBundle(transferEvent));

    let state: PeerRequestV1 = current;
    const claimActive =
      state.state === "CLAIMED" && state.claim !== null && Date.parse(state.claim.expiresAt) > Date.parse(now);
    if (!claimActive) {
      nextWorkspaceRev += 1;
      const claimExpiresAt = new Date(Date.parse(now) + DEFAULT_CLAIM_LEASE_MS).toISOString();
      const claimEvent = compilePeerRequestClaimed(
        {
          eventId: `event-${opId}-claim`,
          workspaceRevision: nextWorkspaceRev,
          opId: `${opId}-claim`,
          actor: binding.actor,
          source: binding.source,
          occurredAt: now,
        },
        { requestId, requestRevision: state.revision + 1, expiresAt: claimExpiresAt },
      );
      state = reducePeerRequestEvent(state, claimEvent);
      batch.push(buildPeerEventBundle(claimEvent, requestId));
    }

    nextWorkspaceRev += 1;
    const doneEvent = compilePeerRequestDone(
      {
        eventId: `event-${opId}-done`,
        workspaceRevision: nextWorkspaceRev,
        opId: `${opId}-done`,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
      },
      { requestId, requestRevision: state.revision + 1, claimId: state.claim!.claimId },
    );
    state = reducePeerRequestEvent(state, doneEvent);
    batch.push(buildPeerEventBundle(doneEvent, requestId));

    const inboxRevision = nextWorkspaceRev + 1;
    batch.push(
      buildInboxEnqueueBundle({
        opId,
        workspaceRevision: inboxRevision,
        actor: binding.actor,
        source: binding.source,
        occurredAt: now,
        payload: {
          inboxId: `person:${current.from.personId}`,
          itemId: `peer-reply-${requestId}-${state.revision}`,
          source: "peer_reply",
          sourceRef: requestId,
          sourceEpoch: state.revision,
          dedupeKey: inboxDedupeKey({ source: "peer_reply", sourceRef: requestId, sourceEpoch: state.revision }),
          admission: "dispatchable",
          consumerKind: "interactive_watch",
          taskId: taskId!,
          agentId: null,
          senderPersonId: personId,
          workId: current.to.workId ?? null,
          lane: current.to.lane ?? null,
          correlationId: requestId,
          minRevision: inboxRevision,
          requiredBlobSha256s: [],
          summary: `Handoff accepted for ${execution.executionId} (stewardshipEpoch=${nextEpoch})`,
          enqueuedAt: now,
        },
      }),
    );

    commitBatch(cell, batch);
    return {
      ...cell.readResult(
        opId,
        {
          request: state,
          taskId: taskId!,
          executionId: nextExecution.executionId,
          stewardshipEpoch: nextEpoch,
          stewardNodeId,
          deliveryBaseline: nextExecution.deliveryBaseline ?? null,
          lease: nextLease,
          ...(packet?.wipBundleBlobSha256 ? { wipBundleBlobSha256: packet.wipBundleBlobSha256 } : {}),
          ...(packet?.wipCommitSha ? { wipCommitSha: packet.wipCommitSha } : {}),
        },
        inboxRevision,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  if (action.kind === "peer-takeover") {
    const taskId = requiredString(action.targetId, "<target-id>");
    const reason = requiredString(action.reason, "--reason");
    const { task, execution, snapshotLease } = activeExecutionForTask(cell, taskId);
    const liveLease = cell.projection.currentLease(taskId, now) ?? snapshotLease;
    const holderNodeOnline =
      typeof action.holderNodeOnline === "boolean"
        ? action.holderNodeOnline
        : liveLease !== null && liveLease.phase === "held";
    const disconnectedForMs =
      typeof action.disconnectedForMs === "number"
        ? action.disconnectedForMs
        : liveLease !== null && liveLease.phase === "orphaned"
          ? Math.max(0, Date.parse(now) - Date.parse(liveLease.expiresAt))
          : null;
    const verdict = evaluateOfflineTakeoverAdmission({
      fleetStreamConnected: action.fleetStreamConnected !== false && options?.fleetStreamConnected !== false,
      hasWritePermission: binding.authorizationDecision?.outcome === "allowed",
      holderNodeOnline,
      disconnectedForMs,
      ...(typeof action.thresholdMs === "number" ? { takeoverThresholdMs: action.thresholdMs } : {}),
      humanConfirmed: action.humanConfirmed === true,
    });
    if (!verdict.allowed) {
      reject(verdict.errorCode, verdict.message);
    }

    const previousEpoch = executionStewardshipEpoch(execution);
    const nextEpoch = previousEpoch + 1;
    const stewardNodeId = optionalString(action.nodeId) ?? cell.input.repoId;
    const ttlMs =
      typeof action.ttlMs === "number" && Number.isSafeInteger(action.ttlMs) && action.ttlMs >= 1_000
        ? action.ttlMs
        : DEFAULT_HANDOFF_LEASE_TTL_MS;
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const previousHolder = liveLease
      ? { taskId, executionId: liveLease.executionId, actor: liveLease.actor, source: liveLease.source }
      : null;
    const nextLeaseVersion = (liveLease?.version ?? 0) + 1;
    const nextExecution: ExecutionV1 = {
      ...execution,
      actor: binding.actor,
      stewardshipEpoch: nextEpoch,
      stewardNodeId,
    };
    const nextLease: LeaseV1 = {
      schema: "lease/v1",
      taskId,
      executionId: execution.executionId,
      actor: binding.actor,
      source: binding.source,
      phase: "held",
      expiresAt,
      ttlMs,
      version: nextLeaseVersion,
      stewardshipEpoch: nextEpoch,
    };
    const nextTask: TaskV2 = task.status === "active" ? task : { ...task, status: "active" };
    const nextWorkspaceRev = head + 1;
    const transferEvent: ExecutionStewardshipTransferredEvent = {
      schema: "task-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision: nextWorkspaceRev,
      opId,
      taskId,
      type: "execution_stewardship_transferred",
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        task: nextTask,
        execution: nextExecution,
        lease: nextLease,
        previousHolder,
        previousStewardshipEpoch: previousEpoch,
        stewardshipEpoch: nextEpoch,
        mode: "offline_takeover",
        reason,
        leaseExpiresAt: expiresAt,
        ...(binding.orphanRecovery?.audit ? { orphanRecovery: binding.orphanRecovery.audit } : {}),
        documentClaims: [],
      },
    };
    commitBatch(cell, [buildTaskEventBundle(transferEvent)]);
    return {
      ...cell.readResult(
        opId,
        {
          taskId,
          executionId: nextExecution.executionId,
          previousStewardshipEpoch: previousEpoch,
          stewardshipEpoch: nextEpoch,
          stewardNodeId,
          deliveryBaseline: nextExecution.deliveryBaseline ?? null,
          lease: nextLease,
          thresholdMs: verdict.thresholdMs ?? DEFAULT_OFFLINE_TAKEOVER_THRESHOLD_MS,
          ...(binding.orphanRecovery?.audit ? { orphanRecovery: binding.orphanRecovery.audit } : {}),
        },
        nextWorkspaceRev,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  if (action.kind === "peer-checkpoint") {
    const taskId = requiredString(action.targetId, "<target-id>");
    const { task, execution } = activeExecutionForTask(cell, taskId);
    const currentEpoch = executionStewardshipEpoch(execution);
    const fence = assertExecutionStewardshipFence({
      executionId: execution.executionId,
      currentStewardshipEpoch: currentEpoch,
      currentStewardPersonId: execution.actor.principal.personId,
      ...(execution.stewardNodeId ? { currentStewardNodeId: execution.stewardNodeId } : {}),
      actingPersonId: personId,
      ...(optionalString(action.nodeId) ? { actingNodeId: optionalString(action.nodeId) } : {}),
      ...(typeof action.stewardshipEpoch === "number" ? { expectedStewardshipEpoch: action.stewardshipEpoch } : {}),
    });
    if (!fence.ok) reject(fence.errorCode, fence.message);

    const bundle = options?.preparedHandoff;
    const commitSha =
      bundle?.wipCommitSha ?? optionalString(action.wipCommitSha) ?? "0000000000000000000000000000000000000000";
    const receiptRef = optionalString(action.receiptRef);
    const receiptRefs = receiptRef
      ? [receiptRef]
      : Array.isArray(action.receiptRefs)
        ? (action.receiptRefs as string[])
        : [];
    const checkpoint: ExecutionWipCheckpointV1 = {
      commitSha,
      ...(bundle?.bundleSha256 ? { bundleBlobSha256: bundle.bundleSha256 } : {}),
      receiptRefs,
      recordedAt: now,
      stewardshipEpoch: currentEpoch,
    };
    const nextExecution: ExecutionV1 = {
      ...execution,
      wipCheckpoint: checkpoint,
    };
    const nextWorkspaceRev = head + 1;
    const checkpointEvent: ExecutionWipCheckpointedEvent = {
      schema: "task-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision: nextWorkspaceRev,
      opId,
      taskId,
      type: "execution_wip_checkpointed",
      actor: binding.actor,
      source: binding.source,
      occurredAt: now,
      payload: {
        task,
        execution: nextExecution,
        checkpoint,
        documentClaims: [],
      },
    };
    commitBatch(cell, [buildTaskEventBundle(checkpointEvent)]);
    return {
      ...cell.readResult(
        opId,
        {
          taskId,
          executionId: nextExecution.executionId,
          stewardshipEpoch: currentEpoch,
          checkpoint,
        },
        nextWorkspaceRev,
        null,
      ),
      authorizationDecision: binding.authorizationDecision,
    };
  }

  reject("unsupported_command", `Unsupported peer action: ${action.kind}.`);
}

export function dispatchPeerAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  sourceRevision: number,
): WriteReceiptDraft | Promise<WriteReceiptDraft> {
  const execute = (preparedHandoff?: PreparedHandoffBundle) =>
    cell.entityActionExecutor.run(
      action,
      binding,
      cell.operationId(action, binding, cell.input.repoId, sourceRevision),
      {
        entity: {
          "peer-request": (_contract, intent, actor, opId) =>
            runPeerAction(cell, intent, actor, opId, { ...(preparedHandoff ? { preparedHandoff } : {}) }),
        },
      },
    );
  if (
    (action.kind === "peer-handoff" || action.kind === "peer-checkpoint") &&
    typeof action.targetId === "string" &&
    action.targetId.trim().length > 0
  ) {
    return prepareHandoffBundle({
      rootDir: cell.rootDir,
      targetId: action.targetId.trim(),
      ...(typeof action.wipCommitSha === "string" ? { explicitCommitSha: action.wipCommitSha } : {}),
      ...(typeof action.bundlePath === "string" ? { explicitBundlePath: action.bundlePath } : {}),
    }).then((preparedHandoff) => execute(preparedHandoff));
  }
  if (action.kind === "peer-accept-handoff" && action.materializeWorktree === true) {
    return Promise.resolve(execute()).then(async (receipt): Promise<WriteReceiptDraft> => {
      if (receipt.outcome !== "applied" || typeof receipt.evidence !== "string") return receipt;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(receipt.evidence) as Record<string, unknown>;
      } catch {
        return receipt;
      }
      const sha = typeof payload.wipBundleBlobSha256 === "string" ? payload.wipBundleBlobSha256 : null;
      const commitSha = typeof payload.wipCommitSha === "string" ? payload.wipCommitSha : null;
      const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
      if (sha && commitSha && taskId) {
        const blob = cell.store.readContentBlob(bareSha256(sha));
        if (blob) {
          const materialized: MaterializedHandoffBundle = await materializeHandoffBundle({
            rootDir: cell.rootDir,
            targetId: taskId,
            bundleBytes: blob,
            wipCommitSha: commitSha,
          });
          return { ...receipt, evidence: JSON.stringify({ ...payload, materialized }) };
        }
      }
      return receipt;
    });
  }
  return execute();
}
