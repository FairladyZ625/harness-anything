// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { baseEntityPolicyActions, requireEntityKindContract } from "../src/domain/entity-kind-registry.ts";
import { parseEntityJsonSchema } from "../src/domain/entity-json-schema.ts";
import {
  assertExecutionStewardshipFence,
  classifyPeerIntentRiskTier,
  evaluateOfflineTakeoverAdmission,
  evaluatePeerExecutionCeiling,
  isPeerFrameCausallyReady,
  matchesPeerWatchFilter,
  peerRequestKinds,
  reducePeerRequestEvent,
  verifyPeerSenderIdentity,
  type PeerRequestEventV1,
  type PeerRequestInput,
} from "../src/domain/peer-collaboration.ts";
import { statusWords } from "../src/domain/status-vocabulary.ts";

const blob = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const body = { claim: "The handoff stopped.", requestedAction: "Explain the stop." };
const request = (overrides: Partial<PeerRequestInput> = {}): PeerRequestInput => ({
  requestId: "peer_123",
  from: { personId: "alice", nodeId: "ha-center", sessionHint: "session-a" },
  to: { personId: "bob" },
  kind: "question",
  summary: "Why did the handoff stop?",
  structuredBody: body,
  attachments: [{ sha256: blob, mediaType: "text/plain", access: "read-only" }],
  ...overrides,
});

const start = "2026-11-20T08:00:00.000Z";
const expiry = "2026-11-20T08:01:00.000Z";
const laterExpiry = "2026-11-20T09:00:00.000Z";
type EventType = PeerRequestEventV1["type"];
type EventOf<T extends EventType> = Extract<PeerRequestEventV1, { type: T }>;

function envelope<T extends EventType>(
  type: T,
  payload: EventOf<T>["payload"],
  personId = "bob",
  occurredAt = start,
): EventOf<T> {
  return {
    schema: "peer-request-event/v1",
    eventId: `event-${payload.requestRevision}`,
    workspaceRevision: 10 + payload.requestRevision,
    opId: `op_${payload.requestRevision}`,
    type,
    actor: { principal: { personId }, executor: null },
    source: "remote_direct",
    occurredAt,
    payload,
  } as EventOf<T>;
}

const open = (input = request()) => envelope("peer_request_opened", { requestRevision: 1, request: input }, "alice");
const claim = (requestRevision = 2, expiresAt = expiry, occurredAt = start, personId = "bob") =>
  envelope("peer_request_claimed", { requestId: "peer_123", requestRevision, expiresAt }, personId, occurredAt);
const terminal = { requestId: "peer_123", requestRevision: 3, claimId: "event-2" };
const done = (payload = terminal, occurredAt = start) => envelope("peer_request_done", payload, "bob", occurredAt);
const claimedRequest = () => reducePeerRequestEvent(reducePeerRequestEvent(null, open()), claim());

test("PeerRequest/v1 retains the kind vocabulary accepted by the previous reader", () => {
  assert.deepEqual(peerRequestKinds, ["question", "ops-request", "merge-request", "handoff"]);
  assert.throws(() => reducePeerRequestEvent(null, open(request({ kind: "delegate" as never }))), {
    code: "peer_request_invalid_input",
  });
});

test("PeerRequest has a canonical state store and one registered lifecycle vocabulary", () => {
  const kind = requireEntityKindContract("peer-request");
  assert.deepEqual(
    kind.stateStores.map(({ id, vocabulary }) => ({ id, vocabulary })),
    [{ id: "peer-request.events", vocabulary: ["peer-request.state"] }],
  );
  assert.deepEqual(kind.statusVocabulary?.[0]?.words, statusWords("PeerRequest", "state"));
  assert.deepEqual(
    kind.actionCatalog?.actions.map(({ id }) => id),
    ["ask", "reply", "watch", "inbox", "promote", "handoff", "accept-handoff", "takeover", "checkpoint"],
  );
  assert.ok(!baseEntityPolicyActions.includes("peer-request/pin"));
});

test("PeerRequest folds immutable snapshots and leaves accepted replays idempotent", () => {
  const event = open();
  const original = reducePeerRequestEvent(null, event);
  const claimed = reducePeerRequestEvent(original, claim());
  assert.equal(original.state, "OPEN");
  assert.equal(original.claim, null);
  assert.equal(claimed.state, "CLAIMED");
  assert.equal(claimed.revision, 2);
  assert.equal(reducePeerRequestEvent(claimed, event), claimed);
  assert.equal(reducePeerRequestEvent(claimed, claim()), claimed);
  assert.notEqual(original.attachments, event.payload.request.attachments);
  for (const value of [
    original,
    original.from,
    original.to,
    original.structuredBody,
    original.attachments,
    original.attachments[0],
    claimed.claim,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
});

test("an illegal transition rejects with peer_request_transition_invalid", () => {
  assert.throws(() => reducePeerRequestEvent(null, claim()), { code: "peer_request_transition_invalid" });
  assert.throws(
    () => reducePeerRequestEvent(reducePeerRequestEvent(null, open()), done({ ...terminal, requestRevision: 2 })),
    { code: "peer_request_transition_invalid" },
  );
  const finished = reducePeerRequestEvent(claimedRequest(), done());
  assert.throws(() => reducePeerRequestEvent(finished, claim(4)), { code: "peer_request_transition_invalid" });
});

test("event folds fence request identity, contiguous revisions, and same-revision conflicts", () => {
  const current = claimedRequest();
  assert.throws(() => reducePeerRequestEvent(current, done({ ...terminal, requestId: "another" })), {
    code: "peer_request_id_mismatch",
  });
  assert.throws(() => reducePeerRequestEvent(current, done({ ...terminal, requestRevision: 4 })), {
    code: "peer_request_revision_gap",
  });
  assert.throws(() => reducePeerRequestEvent(current, { ...claim(), eventId: "other-event" }), {
    code: "peer_request_event_conflict",
  });
});

test("claim expiry permits takeover at equality and fences the previous window", () => {
  const current = claimedRequest();
  assert.throws(() => reducePeerRequestEvent(current, claim(3)), { code: "peer_request_claim_lease_active" });
  assert.throws(() => reducePeerRequestEvent(current, done(terminal, expiry)), { code: "peer_request_claim_expired" });
  assert.throws(() => reducePeerRequestEvent(current, claim(3, laterExpiry, expiry, "carol")), {
    code: "peer_request_recipient_mismatch",
  });

  const reclaimed = reducePeerRequestEvent(current, claim(3, laterExpiry, expiry));
  assert.equal(reclaimed.claim?.claimId, "event-3");
  assert.throws(() => reducePeerRequestEvent(reclaimed, done({ ...terminal, requestRevision: 4 }, expiry)), {
    code: "peer_request_claim_mismatch",
  });
  assert.equal(
    reducePeerRequestEvent(reclaimed, done({ ...terminal, requestRevision: 4, claimId: "event-3" }, expiry)).state,
    "DONE",
  );
});

test("the active claimant can answer, reject, or promote the request", () => {
  const current = claimedRequest();
  const reply = { structuredBody: body, attachments: [], minRevision: 42 };
  const answered = reducePeerRequestEvent(current, envelope("peer_request_answered", { ...terminal, reply }));
  assert.equal(answered.state, "ANSWERED");
  assert.equal(answered.reply?.minRevision, 42);
  assert.throws(
    () =>
      reducePeerRequestEvent(
        current,
        envelope("peer_request_answered", { ...terminal, reply: { ...reply, minRevision: -1 } }),
      ),
    { code: "peer_request_invalid_input" },
  );
  const rejected = reducePeerRequestEvent(
    current,
    envelope("peer_request_rejected", { ...terminal, reason: "Already resolved" }),
  );
  assert.equal(rejected.state, "REJECTED");
  assert.equal(rejected.rejectionReason, "Already resolved");
  const promoted = reducePeerRequestEvent(
    current,
    envelope("peer_request_promoted", { ...terminal, promotedTaskId: "task_123" }),
  );
  assert.equal(promoted.state, "PROMOTED");
  assert.equal(promoted.promotedTaskId, "task_123");
  assert.throws(
    () =>
      reducePeerRequestEvent(
        current,
        envelope("peer_request_promoted", terminal as EventOf<"peer_request_promoted">["payload"]),
      ),
    { code: "peer_request_promotion_task_required" },
  );
});

test("registered PeerRequest decoding enforces the PROMOTED task-id discriminator", () => {
  const schema = requireEntityKindContract("peer-request").schema;
  const promoted = reducePeerRequestEvent(
    claimedRequest(),
    envelope("peer_request_promoted", { ...terminal, promotedTaskId: "task_123" }),
  );

  assert.deepEqual(parseEntityJsonSchema(schema, promoted), promoted);
  assert.throws(() => parseEntityJsonSchema(schema, { ...promoted, promotedTaskId: null }), {
    code: "invalid_entity_contract",
  });
  assert.throws(() => parseEntityJsonSchema(schema, { ...promoted, state: "DONE", promotedTaskId: "task_123" }), {
    code: "invalid_entity_contract",
  });
});

test("opening enforces a single 240-character line and read-only SHA-256 attachments", () => {
  assert.equal(reducePeerRequestEvent(null, open(request({ summary: "协".repeat(240) }))).summary.length, 240);
  for (const summary of ["a".repeat(241), "a\nb", "a\n", "a\u2028b", " "]) {
    assert.throws(() => reducePeerRequestEvent(null, open(request({ summary }))), {
      code: "peer_request_invalid_input",
    });
  }
  assert.throws(
    () =>
      reducePeerRequestEvent(
        null,
        open(request({ attachments: [{ sha256: "sha256:abcd", mediaType: "text/plain", access: "read-only" }] })),
      ),
    { code: "peer_request_invalid_input" },
  );
});

test("watch routes reserve replies for --reply-to, work for --work, and global requests for --lane default", () => {
  const global = { source: "peer_request" } as const;
  const lane = { ...global, lane: "ops" };
  const work = { ...lane, workId: "work-1" };
  const reply = { ...work, source: "peer_reply", correlationId: "peer_123" } as const;
  assert.ok(matchesPeerWatchFilter(global, { lane: "default" }));
  assert.ok(!matchesPeerWatchFilter(global, {}));
  assert.ok(!matchesPeerWatchFilter(global, { lane: "ops" }));
  assert.ok(!matchesPeerWatchFilter(global, { workId: "work-1", lane: "default" }));
  assert.ok(matchesPeerWatchFilter(lane, { lane: "ops" }));
  assert.ok(!matchesPeerWatchFilter(work, { lane: "ops" }));
  assert.ok(matchesPeerWatchFilter(work, { workId: "work-1", lane: "default" }));
  assert.ok(!matchesPeerWatchFilter(work, { workId: "work-2", lane: "ops" }));
  assert.ok(matchesPeerWatchFilter(reply, { replyTo: "peer_123", workId: "work-2" }));
  assert.ok(!matchesPeerWatchFilter(reply, { workId: "work-1", lane: "ops" }));
  assert.ok(!matchesPeerWatchFilter(reply, { replyTo: "other", workId: "work-1" }));
  assert.ok(!matchesPeerWatchFilter({ ...work, correlationId: "peer_123" }, { replyTo: "peer_123" }));
});

test("a frame stays pending below minRevision or while any required blob is absent", () => {
  const readyInput = {
    minRevision: 42,
    requiredBlobSha256s: [blob, blob.replace(/a$/u, "b")],
    localWatermark: 42,
    hasLocalBlob: () => true,
  };
  const unexpectedRead = () => assert.fail("an insufficient watermark must short-circuit blob reads");
  assert.equal(isPeerFrameCausallyReady({ ...readyInput, localWatermark: 41, hasLocalBlob: unexpectedRead }), false);
  assert.equal(isPeerFrameCausallyReady({ ...readyInput, localWatermark: NaN, hasLocalBlob: unexpectedRead }), false);
  assert.equal(isPeerFrameCausallyReady({ ...readyInput, hasLocalBlob: (sha256) => sha256 === blob }), false);
  assert.equal(isPeerFrameCausallyReady(readyInput), true);
});

test("a forged from.personId rejects with peer_sender_spoofing_denied", () => {
  assert.deepEqual(verifyPeerSenderIdentity({ claimedPersonId: "alice", authenticatedPersonId: "mallory" }), {
    valid: false,
    errorCode: "peer_sender_spoofing_denied",
  });
  assert.deepEqual(verifyPeerSenderIdentity({ claimedPersonId: "alice", authenticatedPersonId: "alice" }), {
    valid: true,
  });
  assert.throws(() => reducePeerRequestEvent(null, open(request({ from: { personId: "mallory", nodeId: "edge" } }))), {
    code: "peer_sender_spoofing_denied",
  });
});

test("Tier A limits L0 to read-only and denies unconfirmed L1 with peer_local_human_confirmation_required", () => {
  assert.equal(classifyPeerIntentRiskTier("read-only-diagnostic"), "L0");
  assert.equal(classifyPeerIntentRiskTier("shared-ledger-write"), "L1");
  assert.equal(classifyPeerIntentRiskTier("merge"), "L1");
  assert.deepEqual(evaluatePeerExecutionCeiling("L0", { humanConfirmed: true }), { tier: "L0", ceiling: "read-only" });
  assert.deepEqual(evaluatePeerExecutionCeiling("L1", { preflightPassed: true }), {
    tier: "L1",
    ceiling: "local-human-confirmation-required",
    errorCode: "peer_local_human_confirmation_required",
  });
  assert.deepEqual(evaluatePeerExecutionCeiling("L1", { humanConfirmed: true }), {
    tier: "L1",
    ceiling: "local-preflight-required",
    errorCode: "peer_local_preflight_required",
  });
  assert.deepEqual(evaluatePeerExecutionCeiling("L1", { preflightPassed: true, humanConfirmed: true }), {
    tier: "L1",
    ceiling: "write",
  });
});

test("L2 is always draft_only and unknown operations fail closed", () => {
  assert.equal(classifyPeerIntentRiskTier("host-privileged"), "L2");
  assert.equal(classifyPeerIntentRiskTier("unexpected-effect"), "L2");
  assert.equal(classifyPeerIntentRiskTier("constructor"), "L2");
  for (const humanConfirmed of [false, true])
    assert.deepEqual(evaluatePeerExecutionCeiling("L2", { preflightPassed: true, humanConfirmed }), {
      tier: "L2",
      ceiling: "draft_only",
    });
});

test("stewardship epoch fence rejects stale epoch, superseded principal, and superseded node with execution_handed_off", () => {
  assert.deepEqual(
    assertExecutionStewardshipFence({
      executionId: "exe_1",
      currentStewardshipEpoch: 2,
      currentStewardPersonId: "person_bob",
      currentStewardNodeId: "node_bob",
      actingPersonId: "person_bob",
      actingNodeId: "node_bob",
      expectedStewardshipEpoch: 2,
    }),
    { ok: true, currentEpoch: 2 },
  );

  const staleEpoch = assertExecutionStewardshipFence({
    executionId: "exe_1",
    currentStewardshipEpoch: 2,
    currentStewardPersonId: "person_bob",
    actingPersonId: "person_bob",
    expectedStewardshipEpoch: 1,
  });
  assert.equal(staleEpoch.ok, false);
  if (!staleEpoch.ok) assert.equal(staleEpoch.errorCode, "execution_handed_off");

  const oldPrincipal = assertExecutionStewardshipFence({
    executionId: "exe_1",
    currentStewardshipEpoch: 2,
    currentStewardPersonId: "person_bob",
    actingPersonId: "person_alice",
  });
  assert.equal(oldPrincipal.ok, false);
  if (!oldPrincipal.ok) assert.equal(oldPrincipal.errorCode, "execution_handed_off");

  const oldNode = assertExecutionStewardshipFence({
    executionId: "exe_1",
    currentStewardshipEpoch: 2,
    currentStewardPersonId: "person_bob",
    currentStewardNodeId: "node_bob",
    actingPersonId: "person_bob",
    actingNodeId: "node_alice",
  });
  assert.equal(oldNode.ok, false);
  if (!oldNode.ok) assert.equal(oldNode.errorCode, "execution_handed_off");
});

test("offline takeover admission enforces 7545 connectivity, write auth, offline threshold, and L1 human confirmation", () => {
  const base = {
    fleetStreamConnected: true,
    hasWritePermission: true,
    holderNodeOnline: false,
    disconnectedForMs: 20 * 60_000,
    takeoverThresholdMs: 15 * 60_000,
    humanConfirmed: true,
  };
  assert.deepEqual(evaluateOfflineTakeoverAdmission(base), { allowed: true, thresholdMs: 15 * 60_000 });

  const disconnected7545 = evaluateOfflineTakeoverAdmission({ ...base, fleetStreamConnected: false });
  assert.equal(disconnected7545.allowed, false);
  if (!disconnected7545.allowed) assert.equal(disconnected7545.errorCode, "peer_replication_disconnected");

  const noAuth = evaluateOfflineTakeoverAdmission({ ...base, hasWritePermission: false });
  assert.equal(noAuth.allowed, false);
  if (!noAuth.allowed) assert.equal(noAuth.errorCode, "authorization_missing");

  const holderOnline = evaluateOfflineTakeoverAdmission({ ...base, holderNodeOnline: true });
  assert.equal(holderOnline.allowed, false);
  if (!holderOnline.allowed) assert.equal(holderOnline.errorCode, "execution_holder_online");

  const belowThreshold = evaluateOfflineTakeoverAdmission({ ...base, disconnectedForMs: 5 * 60_000 });
  assert.equal(belowThreshold.allowed, false);
  if (!belowThreshold.allowed) assert.equal(belowThreshold.errorCode, "takeover_threshold_not_met");

  const noHuman = evaluateOfflineTakeoverAdmission({ ...base, humanConfirmed: false });
  assert.equal(noHuman.allowed, false);
  if (!noHuman.allowed) assert.equal(noHuman.errorCode, "peer_local_human_confirmation_required");
});
