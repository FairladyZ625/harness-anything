import type { CanonicalCborValue } from "./canonical-cbor.ts";
import type { ProtocolSchemaTupleV2 } from "./actor-axes-binding-v2.ts";
import type {
  AuthorityOperationRegistry,
  AuthorityOperationState
} from "./types.ts";
import { authorityProtocolTuple } from "./types.ts";
import {
  authorityCutoverBoundaryReceiptSchema,
  authorityCutoverControlStateSchema,
  authorityCutoverDrainReceiptSchema,
  authorityCutoverEqualityReceiptSchema,
  authorityCutoverFreezeReceiptSchema,
  authorityCutoverReenableReceiptSchema,
  authorityCutoverScanReceiptSchema,
  authorityProtocolTupleDigest,
  cutoverContractCborDigest as cutoverCborDigest,
  protocolSchemaTupleDigest,
  requireCutoverContractDigest as digestText,
  requireCutoverContractText as requireCutoverText,
  type AuthorityCutoverBoundaryReceipt,
  type AuthorityCutoverControlService,
  type AuthorityCutoverControlState,
  type AuthorityCutoverDrainReceipt,
  type AuthorityCutoverEntityRegistryQualification,
  type AuthorityCutoverEqualityReceipt,
  type AuthorityCutoverFreezeReceipt,
  type AuthorityCutoverReenableReceipt,
  type AuthorityCutoverScanReceipt,
  type AuthorityCutoverScanSnapshot,
  type AuthorityCutoverStateStore,
  type AuthorityPendingClassification,
  type AuthorityProductionRepoScan
} from "./cutover-contract.ts";
import {
  equalityReceipt,
  normalizedClassification,
  operationSnapshot,
  scanReceipt,
  validScanReceipt,
  validateClassification,
  validateProductionRepoScan,
  validateRecoveredState
} from "./cutover-validation.ts";
import { validateAuthorityCutoverEntityRegistryQualification } from "./cutover-registry-qualification.ts";

export {
  authorityCutoverBoundaryReceiptSchema,
  authorityCutoverControlStateSchema,
  authorityCutoverDrainReceiptSchema,
  authorityCutoverEqualityReceiptSchema,
  authorityCutoverFreezeReceiptSchema,
  authorityCutoverReenableReceiptSchema,
  authorityCutoverScanReceiptSchema,
  authorityProtocolTupleDigest,
  protocolSchemaTupleDigest,
  recordedProtocolTupleDigest
} from "./cutover-contract.ts";
export type {
  AuthorityCutoverBoundaryReceipt,
  AuthorityCutoverControlService,
  AuthorityCutoverControlState,
  AuthorityCutoverDrainReceipt,
  AuthorityCutoverEntityRegistryQualification,
  AuthorityCutoverEqualityReceipt,
  AuthorityCutoverFreezeReceipt,
  AuthorityCutoverPhase,
  AuthorityCutoverReenableReceipt,
  AuthorityCutoverScanReceipt,
  AuthorityCutoverScanSnapshot,
  AuthorityCutoverStateStore,
  AuthorityPendingClassification,
  AuthorityPendingDisposition,
  AuthorityProductionRepoScan
} from "./cutover-contract.ts";

export function createAuthorityCutoverControlService(input: {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly selectedSchemaTuple: ProtocolSchemaTupleV2;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly stateStore: AuthorityCutoverStateStore;
  readonly productionScanner: { readonly scan: () => Promise<AuthorityProductionRepoScan> };
  readonly productionContext: {
    readonly authorityId: string;
    readonly configurationDigest: string;
    readonly entityRegistryQualification: AuthorityCutoverEntityRegistryQualification;
    readonly enabledV2WriterKinds: ReadonlyArray<string>;
    readonly assertWriteFenceHeld: () => Promise<void>;
  };
  readonly now?: () => string;
}): AuthorityCutoverControlService {
  const now = input.now ?? (() => new Date().toISOString());
  const selectedSchemaTupleDigest = protocolSchemaTupleDigest(input.selectedSchemaTuple);
  const entityRegistryQualification = validateAuthorityCutoverEntityRegistryQualification(
    input.productionContext.entityRegistryQualification
  );
  const initial: AuthorityCutoverControlState = {
    schema: authorityCutoverControlStateSchema,
    repoId: requireCutoverText(input.repoId, "repoId"),
    workspaceId: requireCutoverText(input.workspaceId, "workspaceId"),
    selectedSchemaTupleDigest,
    phase: "ACTIVE",
    admission: "open",
    classifications: [],
    v1FreshWriterRetired: false,
    updatedAt: now()
  };
  const recovered = input.stateStore.get<AuthorityCutoverControlState>("control");
  let state = recovered ? validateRecoveredState(recovered, initial) : initial;
  let asynchronousControlOperation = false;
  let activeAdmissions = 0;
  const admissionDrainWaiters = new Set<() => void>();
  if (!recovered) input.stateStore.put("control", state);

  return {
    status: () => structuredClone(state),
    runDuringOpenAdmission,
    drain,
    scan,
    confirmEquality,
    activateBoundary,
    freeze,
    reEnable
  };

  async function runDuringOpenAdmission<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (state.admission !== "open") throw new Error(`AUTHORITY_CUTOVER_ADMISSION_CLOSED:${state.phase}`);
    activeAdmissions += 1;
    try {
      return await operation();
    } finally {
      activeAdmissions -= 1;
      if (activeAdmissions === 0) {
        for (const resolve of admissionDrainWaiters) resolve();
        admissionDrainWaiters.clear();
      }
    }
  }

  async function drain(request: {
    readonly classifications: ReadonlyArray<AuthorityPendingClassification>;
  }): Promise<AuthorityCutoverDrainReceipt> {
    return runExclusiveCutoverOperation("drain", () => drainExclusive(request));
  }

  async function drainExclusive(request: {
    readonly classifications: ReadonlyArray<AuthorityPendingClassification>;
  }): Promise<AuthorityCutoverDrainReceipt> {
    if (state.phase === "BOUNDARY_ACTIVE" || state.phase === "WRITES_FROZEN") {
      throw new Error(`AUTHORITY_CUTOVER_DRAIN_INVALID_PHASE:${state.phase}`);
    }
    state = persistState({ ...state, phase: "DRAINING", admission: "closed", updatedAt: now() });
    await waitForAdmittedOperations();
    const records = await input.operationRegistry.list(input.workspaceId);
    const byId = new Map(records.map((record) => [record.opId, record]));
    const merged = new Map(state.classifications.map((entry) => [entry.opId, entry]));
    for (const classification of request.classifications) {
      const record = byId.get(classification.opId);
      if (!record) throw new Error(`AUTHORITY_CUTOVER_CLASSIFICATION_OPERATION_UNKNOWN:${classification.opId}`);
      validateClassification(classification, record);
      merged.set(classification.opId, normalizedClassification(classification));
    }

    const terminalOperationIds: string[] = [];
    const unclassifiedOperationIds: string[] = [];
    for (const record of records) {
      if (terminalStates.has(record.state)) {
        terminalOperationIds.push(record.opId);
        merged.delete(record.opId);
        continue;
      }
      const classification = merged.get(record.opId);
      if (!classification) {
        unclassifiedOperationIds.push(record.opId);
        continue;
      }
      validateClassification(classification, record);
    }
    const classifications = [...merged.values()].sort((left, right) => left.opId.localeCompare(right.opId));
    const status: AuthorityCutoverDrainReceipt["status"] = unclassifiedOperationIds.length === 0
      ? "DRAINED"
      : "BLOCKED_UNCLASSIFIED_OPERATIONS";
    const { freezeReceipt: _priorFreeze, reenableReceipt: _priorReenable, ...boundaryBase } = state;
    state = persistState({
      ...boundaryBase,
      phase: "DRAINING",
      admission: "closed",
      classifications,
      updatedAt: now()
    });
    const recordedAt = now();
    const operationSnapshotDigest = cutoverCborDigest("ha/authority-cutover-operation-snapshot/v1\0", records.map(operationSnapshot) as unknown as CanonicalCborValue);
    const body = {
      schema: authorityCutoverDrainReceiptSchema,
      repoId: input.repoId,
      workspaceId: input.workspaceId,
      status,
      admission: "closed" as const,
      selectedSchemaTupleDigest,
      operationSnapshotDigest,
      terminalOperationIds: terminalOperationIds.sort(),
      classifications,
      unclassifiedOperationIds: unclassifiedOperationIds.sort(),
      recordedAt
    };
    const receiptDigest = cutoverCborDigest("ha/authority-cutover-drain-receipt/v1\0", body as unknown as CanonicalCborValue);
    const receipt: AuthorityCutoverDrainReceipt = {
      ...body,
      receiptId: `drain_${receiptDigest.slice(0, 24)}`,
      receiptDigest
    };
    input.stateStore.put(`receipt:${receipt.receiptId}`, receipt);
    state = persistState({
      ...state,
      phase: status === "DRAINED" ? "DRAINED" : "DRAINING",
      lastDrainReceiptId: receipt.receiptId,
      updatedAt: now()
    });
    return receipt;
  }

  async function scan(request: {
    readonly profileId: "production-final-scan/v1";
  }): Promise<AuthorityCutoverScanReceipt> {
    return runExclusiveCutoverOperation("scan", () => scanExclusive(request));
  }

  async function scanExclusive(request: {
    readonly profileId: "production-final-scan/v1";
  }): Promise<AuthorityCutoverScanReceipt> {
    if ((state.phase !== "DRAINED" && state.phase !== "WRITES_FROZEN") || state.admission !== "closed") {
      throw new Error(`AUTHORITY_CUTOVER_SCAN_INVALID_PHASE:${state.phase}`);
    }
    if (request.profileId !== "production-final-scan/v1") throw new Error("AUTHORITY_CUTOVER_SCAN_PROFILE_UNSUPPORTED");
    validateAuthorityCutoverV2WriterCoverage(
      entityRegistryQualification.requiredKinds,
      input.productionContext.enabledV2WriterKinds
    );
    await input.productionContext.assertWriteFenceHeld();
    const records = await input.operationRegistry.list(input.workspaceId);
    const pending = records.filter((record) => !terminalStates.has(record.state));
    const classified = new Map(state.classifications.map((entry) => [entry.opId, entry]));
    const unclassified = pending.filter((record) => !classified.has(record.opId));
    if (unclassified.length > 0) throw new Error(`AUTHORITY_CUTOVER_SCAN_UNCLASSIFIED_OPERATIONS:${unclassified.map((record) => record.opId).join(",")}`);
    for (const record of pending) validateClassification(classified.get(record.opId)!, record);
    const repository = await input.productionScanner.scan();
    validateProductionRepoScan(repository);
    const operationSnapshotDigest = cutoverCborDigest(
      "ha/authority-cutover-operation-snapshot/v1\0",
      records.map(operationSnapshot) as unknown as CanonicalCborValue
    );
    const snapshot: AuthorityCutoverScanSnapshot = {
      schema: "authority-cutover-scan-snapshot/v1",
      profileId: request.profileId,
      repoId: input.repoId,
      workspaceId: input.workspaceId,
      selectedSchemaTupleDigest,
      phase: state.phase,
      admission: "closed",
      pendingOperationCount: pending.length,
      operationSnapshotDigest,
      configurationDigest: digestText(input.productionContext.configurationDigest, "productionContext.configurationDigest"),
      entityRegistryQualification,
      barrier: {
        schema: "authority-write-fence-observation/v1",
        status: "HELD"
      },
      writerInventory: {
        schema: "authority-production-writer-inventory/v1",
        source: "production-authority-lifecycle/v1",
        authorityId: requireCutoverText(input.productionContext.authorityId, "productionContext.authorityId"),
        configuredAuthorityCount: 1,
        configuredFreshWriters: [{
          protocol: "authority-operation/v1",
          state: state.v1FreshWriterRetired ? "retired" : "disabled"
        }, {
          protocol: "semantic-mutation-envelope/v2",
          state: "admission-closed"
        }]
      },
      legacyFreshWriterRetired: state.v1FreshWriterRetired,
      repository
    };
    const canonicalDigest = cutoverCborDigest("ha/authority-cutover-final-scan/v1\0", snapshot as unknown as CanonicalCborValue);
    const scanSequence = input.stateStore.entries<AuthorityCutoverScanReceipt>()
      .filter(([key]) => key.startsWith("scan:"))
      .length + 1;
    const receipt: AuthorityCutoverScanReceipt = {
      schema: authorityCutoverScanReceiptSchema,
      scanId: `scan_${scanSequence}_${canonicalDigest.slice(0, 16)}`,
      scanSequence,
      canonicalDigest,
      snapshot,
      recordedAt: now()
    };
    input.stateStore.put(`scan:${receipt.scanId}`, receipt);
    state = persistState({ ...state, lastScanId: receipt.scanId, updatedAt: now() });
    return receipt;
  }

  function confirmEquality(request: {
    readonly firstScanId: string;
    readonly secondScanId: string;
  }): AuthorityCutoverEqualityReceipt {
    assertNoAsynchronousCutoverOperation("confirm-equality");
    if (request.firstScanId === request.secondScanId) throw new Error("AUTHORITY_CUTOVER_DISTINCT_SCANS_REQUIRED");
    const first = input.stateStore.get<AuthorityCutoverScanReceipt>(`scan:${requireCutoverText(request.firstScanId, "firstScanId")}`);
    const second = input.stateStore.get<AuthorityCutoverScanReceipt>(`scan:${requireCutoverText(request.secondScanId, "secondScanId")}`);
    if (!validScanReceipt(first) || !validScanReceipt(second)) throw new Error("AUTHORITY_CUTOVER_SCAN_RECEIPT_NOT_FOUND");
    if (state.lastScanId !== second.scanId || first.snapshot.phase !== state.phase || second.snapshot.phase !== state.phase) {
      throw new Error("AUTHORITY_CUTOVER_SCAN_RECEIPT_NOT_CURRENT");
    }
    const status: AuthorityCutoverEqualityReceipt["status"] = first.canonicalDigest === second.canonicalDigest
      ? "DOUBLE_FINAL_SCAN_PASS"
      : "FINAL_SCAN_MISMATCH";
    const recordedAt = now();
    const body = {
      schema: authorityCutoverEqualityReceiptSchema,
      status,
      firstScanId: first.scanId,
      secondScanId: second.scanId,
      canonicalDigest: status === "DOUBLE_FINAL_SCAN_PASS" ? first.canonicalDigest : null,
      recordedAt
    };
    const receiptDigest = cutoverCborDigest("ha/authority-cutover-equality-receipt/v1\0", body as unknown as CanonicalCborValue);
    const receipt: AuthorityCutoverEqualityReceipt = {
      ...body,
      receiptId: `equality_${receiptDigest.slice(0, 24)}`,
      receiptDigest
    };
    input.stateStore.put(`receipt:${receipt.receiptId}`, receipt);
    if (status === "DOUBLE_FINAL_SCAN_PASS") {
      state = persistState({ ...state, lastEqualityReceiptId: receipt.receiptId, updatedAt: now() });
    }
    return receipt;
  }

  function activateBoundary(request: {
    readonly boundaryId: string;
    readonly equalityReceiptId: string;
    readonly expectedSelectedSchemaTupleDigest: string;
  }): AuthorityCutoverBoundaryReceipt {
    assertNoAsynchronousCutoverOperation("activate-boundary");
    if (state.phase !== "DRAINED" || state.admission !== "closed" || state.v1FreshWriterRetired) {
      throw new Error(`AUTHORITY_CUTOVER_BOUNDARY_INVALID_PHASE:${state.phase}`);
    }
    const boundaryId = requireCutoverText(request.boundaryId, "boundaryId");
    if (request.expectedSelectedSchemaTupleDigest !== selectedSchemaTupleDigest) {
      throw new Error("AUTHORITY_CUTOVER_SELECTED_TUPLE_MISMATCH");
    }
    if (request.equalityReceiptId !== state.lastEqualityReceiptId) throw new Error("AUTHORITY_CUTOVER_EQUALITY_RECEIPT_NOT_CURRENT");
    const equality = equalityReceipt(input.stateStore, request.equalityReceiptId);
    const second = scanReceipt(input.stateStore, equality.secondScanId);
    const recordedAt = now();
    const body = {
      schema: authorityCutoverBoundaryReceiptSchema,
      status: "BOUNDARY_ACTIVE" as const,
      boundaryId,
      equalityReceiptId: equality.receiptId,
      equalityReceiptDigest: equality.receiptDigest,
      finalScanDigest: equality.canonicalDigest!,
      entityRegistryQualificationDigest: second.snapshot.entityRegistryQualification.qualificationDigest,
      boundaryHeadCommit: second.snapshot.repository.headCommit,
      selectedSchemaTupleDigest,
      retiredLegacyTuple: authorityProtocolTuple,
      retiredLegacyTupleDigest: authorityProtocolTupleDigest(authorityProtocolTuple),
      v1FreshWriterRetired: true as const,
      retainedV1ReadOnly: true as const,
      admission: "open" as const,
      recordedAt
    };
    const receiptDigest = cutoverCborDigest("ha/authority-cutover-boundary-receipt/v1\0", body as unknown as CanonicalCborValue);
    const receipt: AuthorityCutoverBoundaryReceipt = {
      ...body,
      receiptId: `boundary_${receiptDigest.slice(0, 24)}`,
      receiptDigest
    };
    state = persistState({
      ...state,
      phase: "BOUNDARY_ACTIVE",
      admission: "open",
      v1FreshWriterRetired: true,
      boundary: receipt,
      updatedAt: now()
    });
    input.stateStore.put(`receipt:${receipt.receiptId}`, receipt);
    return receipt;
  }

  function freeze(request: {
    readonly reason: string;
    readonly expectedBoundaryReceiptDigest: string;
  }): AuthorityCutoverFreezeReceipt {
    assertNoAsynchronousCutoverOperation("freeze");
    if (state.phase !== "BOUNDARY_ACTIVE" || !state.boundary || !state.v1FreshWriterRetired) {
      throw new Error(`AUTHORITY_CUTOVER_FREEZE_INVALID_PHASE:${state.phase}`);
    }
    if (request.expectedBoundaryReceiptDigest !== state.boundary.receiptDigest) {
      throw new Error("AUTHORITY_CUTOVER_BOUNDARY_RECEIPT_MISMATCH");
    }
    const lastScan = state.lastScanId ? scanReceipt(input.stateStore, state.lastScanId) : undefined;
    const recordedAt = now();
    const body = {
      schema: authorityCutoverFreezeReceiptSchema,
      status: "CONTAINED_WRITES_FROZEN" as const,
      boundaryId: state.boundary.boundaryId,
      boundaryReceiptDigest: state.boundary.receiptDigest,
      reason: requireCutoverText(request.reason, "freeze.reason"),
      minimumReenableScanSequence: lastScan?.scanSequence ?? 0,
      v1FreshWriterRestored: false as const,
      unionReadRetained: true as const,
      admission: "closed" as const,
      recordedAt
    };
    const receiptDigest = cutoverCborDigest("ha/authority-cutover-freeze-receipt/v1\0", body as unknown as CanonicalCborValue);
    const receipt: AuthorityCutoverFreezeReceipt = {
      ...body,
      receiptId: `freeze_${receiptDigest.slice(0, 24)}`,
      receiptDigest
    };
    const { reenableReceipt: _priorReenable, ...freezeBase } = state;
    state = persistState({
      ...freezeBase,
      phase: "WRITES_FROZEN",
      admission: "closed",
      freezeReceipt: receipt,
      updatedAt: now()
    });
    input.stateStore.put(`receipt:${receipt.receiptId}`, receipt);
    return receipt;
  }

  function reEnable(request: {
    readonly boundaryId: string;
    readonly expectedFreezeReceiptDigest: string;
    readonly equalityReceiptId: string;
    readonly forwardFixRef: string;
  }): AuthorityCutoverReenableReceipt {
    assertNoAsynchronousCutoverOperation("re-enable");
    if (state.phase !== "WRITES_FROZEN" || !state.boundary || !state.freezeReceipt || !state.v1FreshWriterRetired) {
      throw new Error(`AUTHORITY_CUTOVER_REENABLE_INVALID_PHASE:${state.phase}`);
    }
    if (request.boundaryId !== state.boundary.boundaryId) throw new Error("AUTHORITY_CUTOVER_BOUNDARY_ID_MISMATCH");
    if (request.expectedFreezeReceiptDigest !== state.freezeReceipt.receiptDigest) {
      throw new Error("AUTHORITY_CUTOVER_FREEZE_RECEIPT_MISMATCH");
    }
    if (request.equalityReceiptId !== state.lastEqualityReceiptId) throw new Error("AUTHORITY_CUTOVER_EQUALITY_RECEIPT_NOT_CURRENT");
    const equality = equalityReceipt(input.stateStore, request.equalityReceiptId);
    const first = scanReceipt(input.stateStore, equality.firstScanId);
    const second = scanReceipt(input.stateStore, equality.secondScanId);
    if (first.snapshot.phase !== "WRITES_FROZEN" || second.snapshot.phase !== "WRITES_FROZEN"
      || first.scanSequence <= state.freezeReceipt.minimumReenableScanSequence
      || second.scanSequence <= state.freezeReceipt.minimumReenableScanSequence) {
      throw new Error("AUTHORITY_CUTOVER_REENABLE_REQUIRES_POST_FREEZE_EQUALITY");
    }
    const recordedAt = now();
    const body = {
      schema: authorityCutoverReenableReceiptSchema,
      status: "V2_ADMISSION_REENABLED" as const,
      boundaryId: state.boundary.boundaryId,
      freezeReceiptDigest: state.freezeReceipt.receiptDigest,
      equalityReceiptId: equality.receiptId,
      forwardFixRef: requireCutoverText(request.forwardFixRef, "forwardFixRef"),
      v1FreshWriterRestored: false as const,
      admission: "open" as const,
      recordedAt
    };
    const receiptDigest = cutoverCborDigest("ha/authority-cutover-reenable-receipt/v1\0", body as unknown as CanonicalCborValue);
    const receipt: AuthorityCutoverReenableReceipt = {
      ...body,
      receiptId: `reenable_${receiptDigest.slice(0, 24)}`,
      receiptDigest
    };
    state = persistState({
      ...state,
      phase: "BOUNDARY_ACTIVE",
      admission: "open",
      reenableReceipt: receipt,
      updatedAt: now()
    });
    input.stateStore.put(`receipt:${receipt.receiptId}`, receipt);
    return receipt;
  }

  function persistState(next: AuthorityCutoverControlState): AuthorityCutoverControlState {
    input.stateStore.put("control", next);
    return next;
  }

  async function runExclusiveCutoverOperation<Value>(name: string, operation: () => Promise<Value>): Promise<Value> {
    assertNoAsynchronousCutoverOperation(name);
    asynchronousControlOperation = true;
    try {
      return await operation();
    } finally {
      asynchronousControlOperation = false;
    }
  }

  function assertNoAsynchronousCutoverOperation(name: string): void {
    if (asynchronousControlOperation) throw new Error(`AUTHORITY_CUTOVER_CONTROL_BUSY:${name}`);
  }

  function waitForAdmittedOperations(): Promise<void> {
    if (activeAdmissions === 0) return Promise.resolve();
    return new Promise((resolve) => admissionDrainWaiters.add(resolve));
  }
}

/** A production final scan may only start when every canonical kind has an enabled V2 writer. */
export function validateAuthorityCutoverV2WriterCoverage(
  requiredKinds: ReadonlyArray<string>,
  enabledKinds: ReadonlyArray<string>
): void {
  const required = [...new Set(requiredKinds)].sort();
  const enabled = [...new Set(enabledKinds)].sort();
  const missing = required.filter((kind) => !enabled.includes(kind));
  const unexpected = enabled.filter((kind) => !required.includes(kind));
  if (enabled.length !== enabledKinds.length || missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      "AUTHORITY_CUTOVER_V2_WRITER_KIND_SET_INCOMPLETE",
      `missing=${missing.join(",") || "none"}`,
      `unexpected=${unexpected.join(",") || "none"}`
    ].join(":"));
  }
}

const terminalStates = new Set<AuthorityOperationState>([
  "COMMITTED",
  "REJECTED",
  "RETRYABLE_NOT_COMMITTED",
  "INDETERMINATE"
]);
