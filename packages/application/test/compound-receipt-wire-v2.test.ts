// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCompoundExit,
  compoundExitCodes,
  compoundReceiptV2Schema,
  createCompoundReceiptServiceV2,
  createCompoundReceiptWireBrokerV1,
  createHistoricalExcludedSetWitnessV1,
  decodeCompoundReceiptWireFrameV1,
  encodeCompoundReceiptWireFrameV1,
  isCompoundOperationReceiptV2,
  preparedReceiptDigestV2,
  type AppliedExactAtCutV2,
  type AuthorityCommittedReceipt,
  type CompoundOperationReceiptV2,
  type CompoundReceiptStoreV2,
  type CompoundTerminalJournalEntry,
  type ReceiptIdentityV2
} from "../src/index.ts";

const token = Buffer.alloc(32, 0x41).toString("base64url");
const otherToken = Buffer.alloc(32, 0x42).toString("base64url");

test("compound v2 preserves opaque epoch and hashes the complete sorted historical witness", () => {
  const forward = historicalWitness(false);
  const reverse = historicalWitness(true);
  assert.equal(forward.epochToken, "epoch:opaque:not-a-number");
  assert.equal(forward.canonicalWitnessDigest, reverse.canonicalWitnessDigest);
  assert.deepEqual(forward.fingerprints.map((entry) => entry.path), ["a.md", "z.md"]);
  assert.deepEqual(forward.watcherFenceEntries.map((entry) => entry.path), ["a.md", "z.md"]);
  assert.match(forward.canonicalWitnessDigest, /^[a-f0-9]{64}$/u);
  assert.throws(() => decodeCompoundReceiptWireFrameV1({
    type: "harness-compound-receipt-wire/v1",
    kind: "OPEN_WAITER",
    requestId: "request-extra",
    workspaceId: "workspace-v2",
    viewId: "view-v2",
    opId: "op-v2",
    clientReportedPrincipal: "must-be-ignored"
  }), /FIELDS_INVALID/u, "wire allow-list must reject client-reported authority fields");
});

test("independent compound wire uses broker token digest and exact durable ACK", async () => {
  const store = memoryStore();
  const service = createCompoundReceiptServiceV2({
    store,
    now: clock(),
    createWaiterId: () => "waiter-v2",
    createResultToken: () => token
  });
  const wire = createCompoundReceiptWireBrokerV1(service);
  const opened = await wire.handle({
    type: "harness-compound-receipt-wire/v1",
    kind: "OPEN_WAITER",
    requestId: "request-open",
    workspaceId: "workspace-v2",
    viewId: "view-v2",
    opId: "op-v2"
  });
  assert.equal(opened.kind, "WAITER_OPENED");
  if (opened.kind !== "WAITER_OPENED") return;
  const identity = identityOf(opened);
  const durablePending = await store.get(identity);
  assert.equal(durablePending?.schema, compoundReceiptV2Schema);
  assert.equal("resultToken" in (durablePending ?? {}), false);
  assert.notEqual(durablePending?.resultTokenDigest, token);

  await service.recordAuthority(identity, committed(identity));
  await service.recordOrigin(identity, exactOrigin(identity));
  const prepared = await service.prepareResult(identity);
  const preparedFrame = wire.resultPrepared(prepared);
  assert.equal(preparedFrame.preparedReceiptDigest, preparedReceiptDigestV2(prepared));
  assert.equal(prepared.originPin?.state, "PINNED");
  assert.equal(prepared.pinReleaseEligible, false);
  assert.equal(Buffer.from(encodeCompoundReceiptWireFrameV1(preparedFrame)).toString("utf8").includes(token), false);
  assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: prepared }).symbol, "INTERNAL_ERROR");
  assert.deepEqual(
    decodeCompoundReceiptWireFrameV1(encodeCompoundReceiptWireFrameV1(preparedFrame)),
    preparedFrame
  );

  await assert.rejects(wire.handle({
    type: "harness-compound-receipt-wire/v1",
    kind: "DELIVERY_ACK",
    workspaceId: identity.workspaceId,
    viewId: identity.viewId,
    opId: identity.opId,
    waiterId: identity.waiterId,
    resultToken: otherToken,
    preparedSequence: preparedFrame.preparedSequence,
    preparedReceiptDigest: preparedFrame.preparedReceiptDigest
  }), /result token mismatch/u);
  assert.equal(store.journal.length, 0);
  await assert.rejects(wire.handle({
    type: "harness-compound-receipt-wire/v1",
    kind: "DELIVERY_ACK",
    workspaceId: identity.workspaceId,
    viewId: identity.viewId,
    opId: identity.opId,
    waiterId: identity.waiterId,
    resultToken: token,
    preparedSequence: preparedFrame.preparedSequence + 1,
    preparedReceiptDigest: preparedFrame.preparedReceiptDigest
  }), /prepared sequence or digest mismatch/u);
  assert.equal(store.journal.length, 0);

  const exactAck = {
    type: "harness-compound-receipt-wire/v1" as const,
    kind: "DELIVERY_ACK" as const,
    workspaceId: identity.workspaceId,
    viewId: identity.viewId,
    opId: identity.opId,
    waiterId: identity.waiterId,
    resultToken: token,
    preparedSequence: preparedFrame.preparedSequence,
    preparedReceiptDigest: preparedFrame.preparedReceiptDigest
  };
  const acknowledged = await wire.handle(exactAck);
  assert.equal(acknowledged.kind, "ACK_COMMITTED");
  if (acknowledged.kind !== "ACK_COMMITTED") return;
  assert.equal(acknowledged.terminalLSN, 1);
  assert.equal(acknowledged.receipt.acknowledgement?.epochToken, "epoch:opaque:not-a-number");
  assert.equal(acknowledged.receipt.acknowledgement?.witnessDigest, exactOrigin(identity).witnessDigest);
  assert.equal(acknowledged.receipt.pinReleaseEligible, true);
  assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: acknowledged.receipt }).code, 0);
  const duplicate = await wire.handle(exactAck);
  assert.equal(duplicate.kind === "ACK_COMMITTED" && duplicate.terminalLSN, 1);
  assert.equal(store.journal.length, 1, "duplicate ACK must not allocate another terminalLSN");
  assert.equal(store.journal[0]?.pinReleaseEligible, true);

  const missing = await wire.handle({
    type: "harness-compound-receipt-wire/v1",
    kind: "GET_WAITER",
    requestId: "request-get",
    workspaceId: identity.workspaceId,
    viewId: identity.viewId,
    opId: identity.opId,
    waiterId: identity.waiterId,
    resultToken: otherToken
  });
  assert.equal(missing.kind === "WAITER_STATE" && missing.state, "NOT_FOUND");
  assert.equal(Object.keys(compoundExitCodes).length, 12);
});

test("ACK and detach share one monotonic terminal journal and first durable event wins", async () => {
  const store = memoryStore();
  let waiter = 0;
  const service = createCompoundReceiptServiceV2({
    store,
    now: clock(),
    createWaiterId: () => `waiter-${++waiter}`,
    createResultToken: () => token
  });
  const first = await service.openWaiter({ workspaceId: "w", viewId: "v", opId: "op-1" });
  const detached = await service.detach(first.identity, "transport-observed half-close");
  assert.equal(detached.delivery, "DETACHED");
  assert.equal(detached.terminalLSN, 1);
  assert.equal(detached.pinReleaseEligible, true);
  await assert.rejects(service.commitAcknowledgement({
    ...first.identity,
    resultToken: first.resultToken,
    preparedSequence: 0,
    preparedReceiptDigest: "00".repeat(32)
  }), /cannot advance terminal delivery DETACHED/u);

  const second = await service.openWaiter({ workspaceId: "w", viewId: "v", opId: "op-2" });
  const secondDetached = await service.detach(second.identity, "transport-observed half-close");
  assert.equal(secondDetached.terminalLSN, 2);
  assert.deepEqual(store.journal.map((entry) => entry.kind), ["DETACHED", "DETACHED"]);
});

test("missing V2 authority integrity tuple becomes protocol damaged and never exit zero", async () => {
  const store = memoryStore();
  const service = createCompoundReceiptServiceV2({
    store,
    now: clock(),
    createWaiterId: () => "waiter-damaged",
    createResultToken: () => token
  });
  const opened = await service.openWaiter({ workspaceId: "workspace-v2", viewId: "view-v2", opId: "op-v2" });
  const complete = committed(opened.identity);
  const { authorityIntegrity: _authorityIntegrity, integrityTuple: _integrityTuple, ...incomplete } = complete;
  await service.recordAuthority(opened.identity, incomplete);
  await service.recordOrigin(opened.identity, exactOrigin(opened.identity));
  const damaged = await service.prepareResult(opened.identity);
  assert.equal(damaged.delivery, "PROTOCOL_DAMAGED");
  assert.notEqual(classifyCompoundExit({ kind: "RECEIPT", receipt: damaged }).code, 0);
  assert.equal(isCompoundOperationReceiptV2({ ...damaged, delivery: "RESULT_PREPARED" }), false);
});

function historicalWitness(reverse: boolean) {
  const fingerprints = [
    { path: "a.md", objectKind: "file" as const, logicalMode: 0o644, byteSize: 1, blobDigest: "sha256:a" },
    { path: "z.md", objectKind: "tombstone" as const, logicalMode: 0, byteSize: 0, blobDigest: "sha256:z" }
  ];
  const watcherFenceEntries = [
    { path: "a.md", fenceToken: "fence-a" },
    { path: "z.md", fenceToken: "fence-z" }
  ];
  return createHistoricalExcludedSetWitnessV1({
    cutId: "cut-v2",
    epochToken: "epoch:opaque:not-a-number",
    revision: 7,
    selectedPathSetDigest: "sha256:selected",
    cutJournalLSN: 70,
    writerExclusionId: "exclusion-v2",
    fingerprints: reverse ? fingerprints.toReversed() : fingerprints,
    watcherFenceEntries: reverse ? watcherFenceEntries.toReversed() : watcherFenceEntries
  });
}

function exactOrigin(identity: ReceiptIdentityV2): AppliedExactAtCutV2 {
  const witness = historicalWitness(false);
  return {
    tag: "APPLIED_EXACT_AT_CUT",
    viewId: identity.viewId,
    opId: identity.opId,
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

function committed(identity: ReceiptIdentityV2): AuthorityCommittedReceipt {
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

function identityOf(value: { readonly workspaceId: string; readonly viewId: string; readonly opId: string; readonly waiterId: string }): ReceiptIdentityV2 {
  return { workspaceId: value.workspaceId, viewId: value.viewId, opId: value.opId, waiterId: value.waiterId };
}

function clock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 16, 0, 0, tick++)).toISOString();
}

function memoryStore(): CompoundReceiptStoreV2 & { readonly journal: CompoundTerminalJournalEntry[] } {
  const receipts = new Map<string, CompoundOperationReceiptV2>();
  const journal: CompoundTerminalJournalEntry[] = [];
  let nextTerminalLSN = 1;
  const key = (identity: ReceiptIdentityV2) => [identity.workspaceId, identity.viewId, identity.opId, identity.waiterId].join("\0");
  return {
    journal,
    get: async (identity) => receipts.get(key(identity)),
    create: async (receipt) => {
      const current = receipts.get(key(receipt));
      if (current) return current;
      receipts.set(key(receipt), receipt);
      return receipt;
    },
    compareAndSet: async (identity, expected, receipt) => {
      const current = receipts.get(key(identity));
      if (!current || current.sequence !== expected) return false;
      receipts.set(key(identity), receipt);
      return true;
    },
    commitTerminal: async (identity, expected, draft, build) => {
      const current = receipts.get(key(identity));
      if (!current || current.sequence !== expected) return undefined;
      const terminalLSN = nextTerminalLSN++;
      const receipt = build(terminalLSN);
      receipts.set(key(identity), receipt);
      journal.push({ ...draft, terminalLSN, receiptSequence: receipt.sequence });
      return receipt;
    }
  };
}
