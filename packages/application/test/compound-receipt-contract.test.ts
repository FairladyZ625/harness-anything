// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCompoundExit,
  compoundExitCodes,
  compoundExitDefinitions,
  compoundReceiptSchema,
  createCompoundReceiptService,
  isCompoundOperationReceipt,
  type AuthorityCommittedReceipt,
  type AuthorityOperationReceipt,
  type CompoundExitInput,
  type CompoundOperationReceipt,
  type CompoundReceiptStore,
  type ImmutableReceiptAcknowledgement,
  type OriginResolution,
  type ReceiptIdentity
} from "../src/index.ts";

const identity: ReceiptIdentity = {
  workspaceId: "workspace-1",
  viewId: "view-1",
  opId: "op-1",
  waiterId: "waiter-1",
  resultToken: "result-1"
};

const committed = authority("COMMITTED") as AuthorityCommittedReceipt;

test("compound receipt advances monotonically and keeps historical cut separate from current lease", async () => {
  const store = memoryStore();
  const service = createCompoundReceiptService({ store, now: sequenceClock() });
  const pending = await service.initialize(identity);
  assert.equal(pending.phase, "PENDING");

  const authorityRecorded = await service.recordAuthority(identity, committed);
  assert.equal(authorityRecorded.phase, "COMMITTED");

  const applied = await service.recordOrigin(identity, origin("APPLIED_EXACT_AT_CUT"));
  assert.equal(applied.phase, "APPLIED_EXACT_AT_CUT");
  assert.equal(applied.currentLease, "NOT_REQUESTED");

  const leased = await service.setCurrentLease(identity, "SATISFIED");
  const revoked = await service.setCurrentLease(identity, "REVOKED");
  assert.equal(revoked.currentLease, "REVOKED");
  assert.deepEqual(revoked.origin, leased.origin, "lease revocation must not erase the historical witness");

  const prepared = await service.prepareResult(identity);
  assert.equal(prepared.delivery, "RESULT_PREPARED");
  assert.notEqual(classifyCompoundExit({ kind: "RECEIPT", receipt: prepared }).code, 0);

  const acknowledged = await service.commitAcknowledgement(identity, acknowledgement(91));
  assert.equal(acknowledged.phase, "ACK_COMMITTED");
  assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: acknowledged }).code, 0);
  assert.equal((await service.initialize(identity)).phase, "ACK_COMMITTED", "initialize must resume, not reset");

  await assert.rejects(service.detach(identity, "late detach"), /terminal delivery ACK_COMMITTED/u);
  await assert.rejects(service.setCurrentLease(identity, "SATISFIED"), /cannot be resurrected/u);
});

test("RESULT_PREPARED fails closed to PROTOCOL_DAMAGED without the complete V2 integrity tuple", async () => {
  const store = memoryStore();
  const service = createCompoundReceiptService({ store, now: sequenceClock() });
  await service.initialize(identity);
  await service.recordAuthority(identity, incompleteCommitted());
  await service.recordOrigin(identity, origin("APPLIED_EXACT_AT_CUT"));

  const damaged = await service.prepareResult(identity);
  assert.equal(damaged.delivery, "PROTOCOL_DAMAGED");
  assert.notEqual(classifyCompoundExit({ kind: "RECEIPT", receipt: damaged }).code, 0);
  assert.deepEqual(await service.prepareResult(identity), damaged, "terminal protocol damage must replay without mutation");
  assert.equal(isCompoundOperationReceipt(receipt({
    phase: "APPLIED_EXACT_AT_CUT",
    authority: incompleteCommitted(),
    origin: origin("APPLIED_EXACT_AT_CUT"),
    delivery: "RESULT_PREPARED"
  })), false);
});

test("ACK canonical event digest must exactly match the prepared authority tuple", async () => {
  const store = memoryStore();
  const service = createCompoundReceiptService({ store, now: sequenceClock() });
  await service.initialize(identity);
  await service.recordAuthority(identity, committed);
  await service.recordOrigin(identity, origin("APPLIED_EXACT_AT_CUT"));
  await service.prepareResult(identity);

  await assert.rejects(service.commitAcknowledgement(identity, {
    ...acknowledgement(91),
    canonicalEventDigest: "99".repeat(32)
  }), /integrity tuple does not match/u);
  assert.equal((await store.get(identity))?.delivery, "RESULT_PREPARED");
});

test("exit zero requires all three proofs", () => {
  const exact = receipt({
    phase: "APPLIED_EXACT_AT_CUT",
    authority: committed,
    origin: origin("APPLIED_EXACT_AT_CUT"),
    delivery: "RESULT_PREPARED"
  });
  assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: exact }).symbol, "INTERNAL_ERROR");

  const noExact = receipt({
    phase: "ACK_COMMITTED",
    authority: committed,
    delivery: "ACK_COMMITTED",
    terminalLSN: 1
  });
  assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: noExact }).symbol, "INTERNAL_ERROR");

  const noCommit = receipt({
    phase: "ACK_COMMITTED",
    authority: authority("RETRYABLE_NOT_COMMITTED"),
    origin: origin("APPLIED_EXACT_AT_CUT"),
    delivery: "ACK_COMMITTED",
    terminalLSN: 1
  });
  assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: noCommit }).symbol, "NOT_COMMITTED_RETRYABLE");
});

test("all twelve exit codes have a reproducible positive scenario", () => {
  const cases: ReadonlyArray<readonly [keyof typeof compoundExitCodes, CompoundExitInput]> = [
    ["COMMITTED_APPLIED", { kind: "RECEIPT", receipt: receipt({ phase: "ACK_COMMITTED", authority: committed, origin: origin("APPLIED_EXACT_AT_CUT"), delivery: "ACK_COMMITTED", terminalLSN: 12, acknowledgement: acknowledgement(12) }) }],
    ["NOT_COMMITTED", { kind: "RECEIPT", receipt: receipt({ authority: authority("REJECTED") }) }],
    ["COMMITTED_LOCAL_CONFLICT", { kind: "RECEIPT", receipt: receipt({ phase: "COMMITTED", authority: committed, origin: origin("LOCAL_CONFLICT") }) }],
    ["COMMITTED_APPLY_BLOCKED", { kind: "RECEIPT", receipt: receipt({ phase: "COMMITTED", authority: committed, origin: origin("NONQUIESCENT") }) }],
    ["AUTHORITY_INDETERMINATE", { kind: "RECEIPT", receipt: receipt({ authority: authority("INDETERMINATE") }) }],
    ["NOT_COMMITTED_RETRYABLE", { kind: "RECEIPT", receipt: receipt({ authority: authority("RETRYABLE_NOT_COMMITTED") }) }],
    ["RESYNC_OR_UPGRADE_REQUIRED", { kind: "RESYNC_OR_UPGRADE_REQUIRED" }],
    ["COMMITTED_SUPERSEDED", { kind: "RECEIPT", receipt: receipt({ phase: "COMMITTED", authority: committed, origin: origin("SUPERSEDED") }) }],
    ["COMMITTED_VIEW_UNAVAILABLE", { kind: "RECEIPT", receipt: receipt({ phase: "COMMITTED", authority: committed, origin: origin("VIEW_UNAVAILABLE") }) }],
    ["LOCAL_BUSY_UNSENT", { kind: "LOCAL_BUSY_UNSENT" }],
    ["INTERNAL_ERROR", { kind: "INTERNAL_ERROR" }],
    ["USAGE_ERROR", { kind: "USAGE_ERROR" }]
  ];

  assert.equal(cases.length, 12);
  assert.deepEqual(Object.keys(compoundExitDefinitions), cases.map(([symbol]) => symbol));
  for (const [symbol, input] of cases) {
    const actual = classifyCompoundExit(input);
    assert.equal(actual.symbol, symbol);
    assert.equal(actual.code, compoundExitCodes[symbol]);
    assert.ok(actual.nextAction.length > 0);
    assert.ok(actual.detectionCondition.length > 0);
  }
});

function authority(tag: AuthorityOperationReceipt["tag"]): AuthorityOperationReceipt {
  const base = { workspaceId: identity.workspaceId, opId: identity.opId, semanticDigest: "sha256:request" };
  if (tag === "COMMITTED") return {
    ...base,
    tag,
    revision: 7,
    commitSha: "abc",
    previousCommit: "def",
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: base.semanticDigest,
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
  if (tag === "INDETERMINATE") return { ...base, tag, reason: "continuity lost" };
  return { ...base, tag, reason: tag === "REJECTED" ? "base conflict" : "no effect" };
}

function incompleteCommitted(): AuthorityOperationReceipt {
  const { authorityIntegrity: _authorityIntegrity, integrityTuple: _integrityTuple, ...incomplete } = committed;
  return incomplete;
}

function origin(tag: OriginResolution["tag"]): OriginResolution {
  const base = { viewId: identity.viewId, opId: identity.opId };
  if (tag === "APPLIED_EXACT_AT_CUT") return { ...base, tag, version: 7, cutId: "cut-7", cutKind: "WRITE_EXCLUDED", cutJournalLSN: 71, verifiedAffectedDigest: "sha256:affected", writerExclusionId: "exclude-1" };
  if (tag === "SUPERSEDED") return { ...base, tag, committedVersion: 7, visibleVersion: 8 };
  if (tag === "LOCAL_CONFLICT") return { ...base, tag, conflictIds: ["conflict-1"] };
  if (tag === "APPLY_BLOCKED") return { ...base, tag, reasons: ["permission"] };
  if (tag === "NONQUIESCENT") return { ...base, tag, writerSetReason: "writer mapping remains" };
  return { ...base, tag, reason: "detached" };
}

function receipt(overrides: Partial<CompoundOperationReceipt>): CompoundOperationReceipt {
  return {
    schema: compoundReceiptSchema,
    ...identity,
    phase: "PENDING",
    delivery: "PENDING",
    currentLease: "NOT_REQUESTED",
    sequence: 0,
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

function acknowledgement(terminalLSN: number): ImmutableReceiptAcknowledgement {
  return {
    viewId: identity.viewId,
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    epoch: 2,
    revision: 7,
    commitSha: "abc",
    canonicalEventDigest: "44".repeat(32),
    affectedDigest: "sha256:affected",
    cutId: "cut-7",
    cutKind: "WRITE_EXCLUDED",
    cutJournalLSN: 71,
    writerExclusionId: "exclude-1",
    waiterId: identity.waiterId,
    terminalLSN
  };
}

function memoryStore(): CompoundReceiptStore {
  let stored: CompoundOperationReceipt | undefined;
  return {
    get: async () => stored && structuredClone(stored),
    create: async (candidate) => {
      stored ??= structuredClone(candidate);
      return structuredClone(stored);
    },
    compareAndSet: async (_key, expected, candidate) => {
      if (!stored || stored.sequence !== expected) return false;
      stored = structuredClone(candidate);
      return true;
    }
  };
}

function sequenceClock(): () => string {
  let value = 0;
  return () => `2026-07-13T00:00:${String(value++).padStart(2, "0")}.000Z`;
}
