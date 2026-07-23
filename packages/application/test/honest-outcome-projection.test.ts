// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { coreFailureRegistry, isHonestReceiptOutcomeV1 } from "../../api-contracts/src/honest-receipt-outcome.ts";
import {
  classifyCompoundExit,
  compoundReceiptSchema,
  compoundReceiptV2Schema,
  createHistoricalExcludedSetWitnessV1,
  encodeCompoundReceiptWireFrameV1,
  preparedReceiptDigestV2,
  projectCompoundReceiptEnvelope,
  projectCompoundReceiptHonestOutcome,
  projectCompoundWireFrameHonestOutcome,
  type AppliedExactAtCutV2,
  type AuthorityCommittedReceipt,
  type AuthorityOperationReceipt,
  type CommandReceipt,
  type CompoundOperationReceipt,
  type CompoundOperationReceiptV2,
  type CompoundReceiptWireFrameV1,
  type OriginResolution,
  type ReceiptIdentityV2
} from "../src/index.ts";

const identity = {
  workspaceId: "workspace-s2",
  viewId: "view-s2",
  opId: "op-s2",
  waiterId: "waiter-s2",
  resultToken: "token-s2"
} as const;

test("compound V1 and V2 receipts map every authority, origin, delivery, and wire member", () => {
  const authorityCases: ReadonlyArray<readonly [
    AuthorityOperationReceipt["tag"],
    "confirmed" | "not_reached" | "unknown"
  ]> = [
    ["COMMITTED", "confirmed"],
    ["REJECTED", "not_reached"],
    ["RETRYABLE_NOT_COMMITTED", "not_reached"],
    ["INDETERMINATE", "unknown"]
  ];
  for (const [tag, expected] of authorityCases) {
    const mapped = projectCompoundReceiptHonestOutcome(v1Receipt({
      phase: tag === "COMMITTED" ? "COMMITTED" : "PENDING",
      authority: authority(tag)
    }), coreFailureRegistry);
    assert.equal(mapped.moments.committed.status, expected, tag);
    assert.equal(isHonestReceiptOutcomeV1(mapped), true, tag);
  }

  const originCases: ReadonlyArray<readonly [
    OriginResolution["tag"],
    "confirmed" | "not_reached" | "unknown"
  ]> = [
    ["APPLIED_EXACT_AT_CUT", "confirmed"],
    ["SUPERSEDED", "not_reached"],
    ["LOCAL_CONFLICT", "not_reached"],
    ["APPLY_BLOCKED", "not_reached"],
    ["NONQUIESCENT", "not_reached"],
    ["VIEW_UNAVAILABLE", "unknown"]
  ];
  for (const [tag, expected] of originCases) {
    const mapped = projectCompoundReceiptHonestOutcome(v1Receipt({
      phase: tag === "APPLIED_EXACT_AT_CUT" ? "APPLIED_EXACT_AT_CUT" : "COMMITTED",
      authority: committed(),
      origin: origin(tag)
    }), coreFailureRegistry);
    assert.equal(mapped.moments.applied.status, expected, tag);
    assert.notEqual(mapped.moments.visible.status, "confirmed", tag);
    assert.equal(isHonestReceiptOutcomeV1(mapped), true, tag);
  }

  const prepared = preparedV2();
  const acknowledged = acknowledgedV2(prepared);
  const deliveryCases: ReadonlyArray<CompoundOperationReceipt | CompoundOperationReceiptV2> = [
    v1Receipt({}),
    prepared,
    acknowledged,
    v1Receipt({ phase: "COMMITTED", authority: committed(), delivery: "DETACHED", terminalLSN: 8 }),
    v1Receipt({ phase: "COMMITTED", authority: committed(), delivery: "PROTOCOL_DAMAGED" })
  ];
  assert.deepEqual(
    deliveryCases.map((receipt) =>
      projectCompoundReceiptHonestOutcome(receipt, coreFailureRegistry).moments.acked.status),
    ["unknown", "not_reached", "confirmed", "not_reached", "not_reached"]
  );

  const frames = wireFrames(prepared, acknowledged);
  assert.deepEqual(
    frames.map((frame) => frame.kind),
    ["OPEN_WAITER", "WAITER_OPENED", "RESULT_PREPARED", "DELIVERY_ACK", "ACK_COMMITTED", "GET_WAITER", "WAITER_STATE"]
  );
  for (const frame of frames) {
    assert.equal(isHonestReceiptOutcomeV1(
      projectCompoundWireFrameHonestOutcome(frame, coreFailureRegistry)
    ), true, frame.kind);
  }
});

test("sidecar projection preserves V1/V2 fixture bytes and prepared digest", () => {
  const v1 = v1Receipt({
    phase: "COMMITTED",
    authority: committed(),
    origin: origin("LOCAL_CONFLICT")
  });
  const prepared = preparedV2();
  const frame = wireFrames(prepared, acknowledgedV2(prepared))[2]!;
  const v1Before = Buffer.from(JSON.stringify(v1), "utf8");
  const v2Before = Buffer.from(encodeCompoundReceiptWireFrameV1(frame));
  const digestBefore = preparedReceiptDigestV2(prepared);

  const v1Envelope = projectCompoundReceiptEnvelope(v1, coreFailureRegistry, {
    legacyDigest: "sha256:v1"
  });
  const v2Envelope = projectCompoundReceiptEnvelope(prepared, coreFailureRegistry, {
    legacyDigest: digestBefore
  });

  assert.equal(v1Envelope.legacyReceipt, v1);
  assert.equal(v2Envelope.legacyReceipt, prepared);
  assert.equal(v1Before.equals(Buffer.from(JSON.stringify(v1), "utf8")), true);
  assert.equal(v2Before.equals(Buffer.from(encodeCompoundReceiptWireFrameV1(frame))), true);
  assert.equal(preparedReceiptDigestV2(prepared), digestBefore);
});

test("sidecar creation does not change legacy exit, ok, warnings, or serialized rendering", () => {
  const receipt = acknowledgedV2(preparedV2());
  const commandReceipt: CommandReceipt = {
    ok: true,
    schema: "command-receipt/v2",
    command: "test",
    action: "show",
    summary: "legacy summary",
    warnings: ["legacy warning"],
    meta: {
      generatedAt: "2026-07-23T00:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
  const exitBefore = classifyCompoundExit({ kind: "RECEIPT", receipt });
  const renderedBefore = JSON.stringify(commandReceipt);

  projectCompoundReceiptEnvelope(receipt, coreFailureRegistry);

  assert.deepEqual(classifyCompoundExit({ kind: "RECEIPT", receipt }), exitBefore);
  assert.equal(commandReceipt.ok, true);
  assert.deepEqual(commandReceipt.warnings, ["legacy warning"]);
  assert.equal(JSON.stringify(commandReceipt), renderedBefore);
});

test("exhaustive tables fail closed while legacy-unmapped fallback remains explicit unknown", () => {
  const pending = projectCompoundReceiptHonestOutcome(v1Receipt({}), coreFailureRegistry);
  assert.deepEqual(pending.moments, {
    committed: { status: "unknown", reason: "not_observed" },
    applied: { status: "unknown", reason: "not_observed" },
    visible: { status: "unknown", reason: "not_observed" },
    acked: { status: "unknown", reason: "not_observed" }
  });
  assert.equal(Object.values(pending.moments).some((moment) => moment.status === "confirmed"), false);

  const committedWithoutOrigin = projectCompoundReceiptHonestOutcome(v1Receipt({
    phase: "COMMITTED",
    authority: committed()
  }), coreFailureRegistry);
  assert.deepEqual(committedWithoutOrigin.moments.applied, {
    status: "unknown",
    reason: "not_observed"
  });
  assert.deepEqual(committedWithoutOrigin.moments.visible, {
    status: "unknown",
    reason: "not_observed"
  });
});

function authority(tag: AuthorityOperationReceipt["tag"]): AuthorityOperationReceipt {
  if (tag === "COMMITTED") return committed();
  const base = {
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "11".repeat(32)
  };
  if (tag === "INDETERMINATE") return {
    ...base,
    tag,
    reason: "commit continuity unavailable"
  };
  return {
    ...base,
    tag,
    reason: tag === "REJECTED" ? "request rejected" : "retryable before commit"
  };
}

function committed(): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "11".repeat(32),
    revision: 7,
    commitSha: "commit-7",
    previousCommit: "commit-6",
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "11".repeat(32),
      semanticMutationSetDigest: "22".repeat(32),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "33".repeat(32),
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2",
      canonicalEventDigest: "44".repeat(32),
      changeSetDigest: "55".repeat(32),
      semanticMutationSetDigest: "22".repeat(32),
      actorAxesBindingDigest: "33".repeat(32)
    }
  };
}

function origin(tag: OriginResolution["tag"]): OriginResolution {
  const base = { viewId: identity.viewId, opId: identity.opId };
  if (tag === "APPLIED_EXACT_AT_CUT") return {
    ...base,
    tag,
    version: 7,
    cutId: "cut-7",
    cutKind: "WRITE_EXCLUDED",
    cutJournalLSN: 71,
    verifiedAffectedDigest: "sha256:affected",
    writerExclusionId: "exclude-1"
  };
  if (tag === "SUPERSEDED") return {
    ...base,
    tag,
    committedVersion: 7,
    visibleVersion: 8
  };
  if (tag === "LOCAL_CONFLICT") return {
    ...base,
    tag,
    conflictIds: ["conflict-1"]
  };
  if (tag === "APPLY_BLOCKED") return {
    ...base,
    tag,
    reasons: ["precondition"]
  };
  if (tag === "NONQUIESCENT") return {
    ...base,
    tag,
    writerSetReason: "writer still active"
  };
  return { ...base, tag, reason: "view detached" };
}

function v1Receipt(overrides: Partial<CompoundOperationReceipt>): CompoundOperationReceipt {
  return {
    schema: compoundReceiptSchema,
    ...identity,
    phase: "PENDING",
    delivery: "PENDING",
    currentLease: "NOT_REQUESTED",
    sequence: 0,
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides
  };
}

function exactOriginV2(receiptIdentity: ReceiptIdentityV2): AppliedExactAtCutV2 {
  const witness = createHistoricalExcludedSetWitnessV1({
    cutId: "cut-7",
    epochToken: "epoch-7",
    revision: 7,
    selectedPathSetDigest: "sha256:selected",
    cutJournalLSN: 71,
    writerExclusionId: "exclude-1",
    fingerprints: [{
      path: "task.md",
      objectKind: "file",
      logicalMode: 0o644,
      byteSize: 4,
      blobDigest: "sha256:file"
    }],
    watcherFenceEntries: [{ path: "task.md", fenceToken: "fence-task" }]
  });
  return {
    tag: "APPLIED_EXACT_AT_CUT",
    viewId: receiptIdentity.viewId,
    opId: receiptIdentity.opId,
    version: 7,
    cutId: witness.cutId,
    cutKind: "WRITE_EXCLUDED",
    cutJournalLSN: witness.cutJournalLSN,
    verifiedAffectedDigest: witness.affectedDigest,
    writerExclusionId: witness.writerExclusionId,
    witness,
    witnessDigest: witness.canonicalWitnessDigest
  };
}

function preparedV2(): CompoundOperationReceiptV2 {
  const receiptIdentity = {
    workspaceId: identity.workspaceId,
    viewId: identity.viewId,
    opId: identity.opId,
    waiterId: identity.waiterId
  };
  const exact = exactOriginV2(receiptIdentity);
  return {
    schema: compoundReceiptV2Schema,
    ...receiptIdentity,
    resultTokenDigest: "66".repeat(32),
    phase: "APPLIED_EXACT_AT_CUT",
    authority: committed(),
    origin: exact,
    originPin: {
      state: "PINNED",
      cutId: exact.cutId,
      witnessDigest: exact.witnessDigest
    },
    delivery: "RESULT_PREPARED",
    pinReleaseEligible: false,
    currentLease: "NOT_REQUESTED",
    sequence: 5,
    updatedAt: "2026-07-23T00:00:00.000Z"
  };
}

function acknowledgedV2(prepared: CompoundOperationReceiptV2): CompoundOperationReceiptV2 {
  if (prepared.origin?.tag !== "APPLIED_EXACT_AT_CUT") {
    throw new Error("expected exact origin");
  }
  const digest = preparedReceiptDigestV2(prepared);
  return {
    ...prepared,
    phase: "ACK_COMMITTED",
    delivery: "ACK_COMMITTED",
    pinReleaseEligible: true,
    terminalLSN: 9,
    acknowledgement: {
      viewId: prepared.viewId,
      workspaceId: prepared.workspaceId,
      opId: prepared.opId,
      epochToken: prepared.origin.witness.epochToken,
      revision: 7,
      commitSha: "commit-7",
      canonicalEventDigest: "44".repeat(32),
      changeSetDigest: "55".repeat(32),
      semanticMutationSetDigest: "22".repeat(32),
      actorAxesBindingDigest: "33".repeat(32),
      affectedDigest: prepared.origin.verifiedAffectedDigest,
      cutId: prepared.origin.cutId,
      cutKind: "WRITE_EXCLUDED",
      cutJournalLSN: prepared.origin.cutJournalLSN,
      witnessDigest: prepared.origin.witnessDigest,
      writerExclusionId: prepared.origin.writerExclusionId,
      waiterId: prepared.waiterId,
      preparedSequence: prepared.sequence,
      preparedReceiptDigest: digest,
      terminalLSN: 9
    },
    sequence: 6
  };
}

function wireFrames(
  prepared: CompoundOperationReceiptV2,
  acknowledged: CompoundOperationReceiptV2
): ReadonlyArray<CompoundReceiptWireFrameV1> {
  const preparedDigest = preparedReceiptDigestV2(prepared);
  return [
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "OPEN_WAITER",
      requestId: "request-open",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId
    },
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "WAITER_OPENED",
      requestId: "request-open",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId,
      waiterId: identity.waiterId,
      resultToken: identity.resultToken
    },
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "RESULT_PREPARED",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId,
      waiterId: identity.waiterId,
      preparedSequence: prepared.sequence,
      preparedReceiptDigest: preparedDigest,
      receipt: prepared,
      historicalWitness: prepared.origin!.tag === "APPLIED_EXACT_AT_CUT"
        ? prepared.origin!.witness
        : exactOriginV2(prepared).witness
    },
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "DELIVERY_ACK",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId,
      waiterId: identity.waiterId,
      resultToken: identity.resultToken,
      preparedSequence: prepared.sequence,
      preparedReceiptDigest: preparedDigest
    },
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "ACK_COMMITTED",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId,
      waiterId: identity.waiterId,
      preparedSequence: prepared.sequence,
      preparedReceiptDigest: preparedDigest,
      terminalLSN: acknowledged.terminalLSN!,
      receipt: acknowledged
    },
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "GET_WAITER",
      requestId: "request-get",
      workspaceId: identity.workspaceId,
      viewId: identity.viewId,
      opId: identity.opId,
      waiterId: identity.waiterId,
      resultToken: identity.resultToken
    },
    {
      type: "harness-compound-receipt-wire/v1",
      kind: "WAITER_STATE",
      requestId: "request-get",
      state: "NOT_FOUND"
    }
  ];
}
