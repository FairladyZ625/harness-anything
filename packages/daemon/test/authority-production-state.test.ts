// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAuthorityFixedOperationBindingV1,
  type ActorAxesBindingRecordV2,
  type ActorAxesProofKeyResolverV2
} from "../../application/src/index.ts";
import {
  createDurableAuthorityBindingRuntimeV2,
  type AuthorityProductionRepoConfigV1
} from "../src/authority/production/authority-production-state.ts";
import { registerAuthorityBindingRow } from "../src/authority/production/authority-binding-state.ts";
import {
  openDurableAuthorityServiceState,
  type DurableAuthorityStateTable
} from "../src/authority/production/service-state.ts";

test("durable binding consumption is idempotent for the same inner op and bounded across distinct ops", async () => {
  const table = memoryTable();
  const runtime = createDurableAuthorityBindingRuntimeV2({
    config: productionConfig(1),
    table,
    proofKeys: emptyProofKeys
  });

  assert.equal(await runtime.consumeOperation({
    tokenId: "token-1",
    maximum: 1,
    opId: "namespace-1:operation-a"
  }), "consumed");
  assert.equal(await runtime.consumeOperation({
    tokenId: "token-1",
    maximum: 1,
    opId: "namespace-1:operation-a"
  }), "already-consumed-by-same-op");
  assert.equal(await runtime.consumeOperation({
    tokenId: "token-1",
    maximum: 1,
    opId: "namespace-1:operation-b"
  }), "denied");
});

test("durable binding consumption preserves the inner op identity across service-state restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-binding-consume-"));
  try {
    const firstState = openDurableAuthorityServiceState({
      serviceStateRoot: root,
      repoId: "repo-1"
    });
    const firstRuntime = createDurableAuthorityBindingRuntimeV2({
      config: productionConfig(1),
      table: firstState.bindingState,
      proofKeys: emptyProofKeys
    });
    assert.equal(await firstRuntime.consumeOperation({
      tokenId: "token-1",
      maximum: 1,
      opId: "namespace-1:operation-a"
    }), "consumed");
    await firstState.close();

    const restartedState = openDurableAuthorityServiceState({
      serviceStateRoot: root,
      repoId: "repo-1"
    });
    const restartedRuntime = createDurableAuthorityBindingRuntimeV2({
      config: productionConfig(1),
      table: restartedState.bindingState,
      proofKeys: emptyProofKeys
    });
    assert.equal(await restartedRuntime.consumeOperation({
      tokenId: "token-1",
      maximum: 1,
      opId: "namespace-1:operation-a"
    }), "already-consumed-by-same-op");
    assert.equal(await restartedRuntime.consumeOperation({
      tokenId: "token-1",
      maximum: 1,
      opId: "namespace-1:operation-b"
    }), "denied");
    await restartedState.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable operation state preserves the exact fixed WriteOp across restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fixed-operation-"));
  const semanticDigest = "1".repeat(64);
  const authorityIntegrity = {
    schema: "authority-operation-integrity/v2" as const,
    semanticRequestDigest: semanticDigest,
    semanticMutationSetDigest: "2".repeat(64),
    mutationRegistryVersion: 1,
    actorAxesBindingDigest: "3".repeat(64),
    canonicalMutationSet: { registryVersion: 1, mutations: [] }
  };
  const canonicalOperation = {
    opId: "namespace-1:operation-a",
    entityId: "task:task_A" as const,
    kind: "progress_append" as const,
    payload: { taskId: "task_A", text: "fixed\n" },
    authorityIntegrity
  };
  const fixedOperationBinding = createAuthorityFixedOperationBindingV1({
    repoId: "repo-1",
    workspaceId: "workspace-1",
    writerGeneration: 2,
    authorityGeneration: 1,
    opId: canonicalOperation.opId,
    semanticDigest,
    canonicalRequestEnvelope: "fixed-envelope",
    operation: canonicalOperation
  });
  try {
    const first = openDurableAuthorityServiceState({
      serviceStateRoot: root,
      repoId: "repo-1"
    });
    await first.operationRegistry.put({
      workspaceId: "workspace-1",
      opId: canonicalOperation.opId,
      semanticDigest,
      state: "RECEIVED",
      canonicalRequestEnvelope: "fixed-envelope",
      authorityIntegrity,
      canonicalOperation,
      fixedOperationBinding,
      recoveryPublicationPolicy: "EXACT_FIXED_OPERATION"
    });
    await first.close();

    const restarted = openDurableAuthorityServiceState({
      serviceStateRoot: root,
      repoId: "repo-1"
    });
    const recovered = await restarted.operationRegistry.get(
      "workspace-1",
      canonicalOperation.opId
    );
    assert.deepEqual(recovered?.canonicalOperation, canonicalOperation);
    assert.deepEqual(recovered?.fixedOperationBinding, fixedOperationBinding);
    await assert.rejects(restarted.operationRegistry.put({
      workspaceId: "workspace-1",
      opId: canonicalOperation.opId,
      semanticDigest,
      state: "PREPARED",
      canonicalRequestEnvelope: "fixed-envelope",
      authorityIntegrity,
      canonicalOperation: { ...canonicalOperation, opId: "namespace-1:spliced" },
      fixedOperationBinding,
      recoveryPublicationPolicy: "EXACT_FIXED_OPERATION"
    }), /AUTHORITY_STORED_OPERATION_FIXED_MATERIAL_MISMATCH/u);
    await assert.rejects(restarted.operationRegistry.put({
      workspaceId: "workspace-1",
      opId: canonicalOperation.opId,
      semanticDigest,
      state: "PREPARED",
      canonicalRequestEnvelope: "fixed-envelope",
      authorityIntegrity,
      canonicalOperation: {
        ...canonicalOperation,
        payload: { taskId: "task_A", text: "spliced\n" }
      },
      fixedOperationBinding,
      recoveryPublicationPolicy: "EXACT_FIXED_OPERATION"
    }), /AUTHORITY_STORED_OPERATION_FIXED_BINDING_MISMATCH/u);
    await restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup upgrades legacy count-only consumption into reserved unwitnessed witnesses", async () => {
  const config = productionConfig(2);
  const binding = config.bootstrapBindings[0]!;
  const table = memoryTable([[
    "token:token-1",
    {
      schema: "authority-binding-state/v1",
      tokenId: binding.tokenId,
      tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
      maxOperations: 2,
      consumedOperations: 1,
      record: binding.record
    }
  ]]);
  const runtime = createDurableAuthorityBindingRuntimeV2({
    config: { ...config, bootstrapBindings: [] },
    table,
    proofKeys: emptyProofKeys
  });

  assert.deepEqual(table.get<Record<string, unknown>>("token:token-1"), {
    schema: "authority-binding-state/v2",
    tokenId: "token-1",
    tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
    maxOperations: 2,
    consumedOperations: 1,
    consumedOperationIds: ["legacy-unwitnessed:token-1:1"],
    record: binding.record
  });
  // A reserved witness is never a presentable opId: it may not be replayed into
  // an idempotent hit, and it may not spend the surviving slot either.
  assert.equal(await runtime.consumeOperation({
    tokenId: "token-1",
    maximum: 2,
    opId: "legacy-unwitnessed:token-1:1"
  }), "denied");
  assert.equal(await runtime.consumeOperation({
    tokenId: "token-1",
    maximum: 2,
    opId: "namespace-1:operation-a"
  }), "consumed");
});

test("startup preserves exhaustion for a fully consumed legacy binding row", async () => {
  const config = productionConfig(1);
  const binding = config.bootstrapBindings[0]!;
  const table = memoryTable([[
    "token:token-1",
    {
      schema: "authority-binding-state/v1",
      tokenId: binding.tokenId,
      tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
      maxOperations: binding.maxOperations,
      consumedOperations: binding.maxOperations,
      record: binding.record
    }
  ]]);
  const runtime = createDurableAuthorityBindingRuntimeV2({
    config,
    table,
    proofKeys: emptyProofKeys
  });

  assert.equal(await runtime.consumeOperation({
    tokenId: "token-1",
    maximum: 1,
    opId: "namespace-1:operation-a"
  }), "denied");
});

test("startup upgrades every unconsumed legacy binding row even when it is not bootstrapped", async () => {
  const config = productionConfig(1);
  const binding = config.bootstrapBindings[0]!;
  const table = memoryTable([[
    "token:legacy-unbootstrapped",
    {
      schema: "authority-binding-state/v1",
      tokenId: "legacy-unbootstrapped",
      tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
      maxOperations: 1,
      consumedOperations: 0,
      record: { ...binding.record, bindingId: "legacy-binding" }
    }
  ]]);
  const runtime = createDurableAuthorityBindingRuntimeV2({
    config: { ...config, bootstrapBindings: [] },
    table,
    proofKeys: emptyProofKeys
  });

  assert.equal(await runtime.consumeOperation({
    tokenId: "legacy-unbootstrapped",
    maximum: 1,
    opId: "namespace-1:operation-a"
  }), "consumed");
  assert.deepEqual(table.get<Record<string, unknown>>("token:legacy-unbootstrapped"), {
    schema: "authority-binding-state/v2",
    tokenId: "legacy-unbootstrapped",
    tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
    maxOperations: 1,
    consumedOperations: 1,
    consumedOperationIds: ["namespace-1:operation-a"],
    record: { ...binding.record, bindingId: "legacy-binding" }
  });
});

test("startup rejects v2 binding rows with over-limit or duplicate operation witnesses", () => {
  const config = productionConfig(1);
  const binding = config.bootstrapBindings[0]!;
  const table = memoryTable([[
    "token:token-1",
    {
      schema: "authority-binding-state/v2",
      tokenId: binding.tokenId,
      tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
      maxOperations: 1,
      consumedOperations: 2,
      consumedOperationIds: ["namespace-1:operation-a", "namespace-1:operation-b"],
      record: binding.record
    }
  ]]);

  assert.throws(() => createDurableAuthorityBindingRuntimeV2({
    config,
    table,
    proofKeys: emptyProofKeys
  }), /AUTHORITY_BINDING_DURABLE_MISMATCH/u);

  const duplicateTable = memoryTable([[
    "token:token-1",
    {
      schema: "authority-binding-state/v2",
      tokenId: binding.tokenId,
      tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
      maxOperations: 2,
      consumedOperations: 2,
      consumedOperationIds: ["namespace-1:operation-a", "namespace-1:operation-a"],
      record: binding.record
    }
  ]]);
  assert.throws(() => createDurableAuthorityBindingRuntimeV2({
    config: productionConfig(2),
    table: duplicateTable,
    proofKeys: emptyProofKeys
  }), /AUTHORITY_BINDING_DURABLE_MISMATCH/u);

  const corruptRows = [
    { tokenId: "", tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"), record: binding.record },
    { tokenId: " token-1", tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"), record: binding.record },
    { tokenId: "token-\0one", tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"), record: binding.record },
    { tokenId: binding.tokenId, tokenDigest: "!".repeat(43), record: binding.record },
    { tokenId: binding.tokenId, tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"), record: {} }
  ];
  for (const corrupt of corruptRows) {
    const corruptTable = memoryTable([[
      `token:${corrupt.tokenId}`,
      {
        schema: "authority-binding-state/v2",
        tokenId: corrupt.tokenId,
        tokenDigest: corrupt.tokenDigest,
        maxOperations: 1,
        consumedOperations: 0,
        consumedOperationIds: [],
        record: corrupt.record
      }
    ]]);
    assert.throws(() => createDurableAuthorityBindingRuntimeV2({
      config,
      table: corruptTable,
      proofKeys: emptyProofKeys
    }), /AUTHORITY_BINDING_DURABLE_MISMATCH/u);
  }
  for (const opId of [" namespace-1:operation-a", "namespace-1:operation-\0a"]) {
    const corruptWitnessTable = memoryTable([[
      "token:token-1",
      {
        schema: "authority-binding-state/v2",
        tokenId: binding.tokenId,
        tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
        maxOperations: 1,
        consumedOperations: 1,
        consumedOperationIds: [opId],
        record: binding.record
      }
    ]]);
    assert.throws(() => createDurableAuthorityBindingRuntimeV2({
      config,
      table: corruptWitnessTable,
      proofKeys: emptyProofKeys
    }), /AUTHORITY_BINDING_DURABLE_MISMATCH/u);
  }
});

test("exact recovery preserves a disabled binding while new admission remains denied", async () => {
  const config = productionConfig(1);
  const binding = config.bootstrapBindings[0]!;
  const inactiveRecord = { ...binding.record, active: false };
  const table = memoryTable([[
    "token:token-1",
    {
      schema: "authority-binding-state/v2",
      tokenId: binding.tokenId,
      tokenDigest: Buffer.from(binding.tokenDigest).toString("base64url"),
      maxOperations: 1,
      consumedOperations: 0,
      consumedOperationIds: [],
      record: inactiveRecord
    }
  ]]);
  assert.throws(() => registerAuthorityBindingRow(table, {
    tokenId: binding.tokenId,
    tokenDigest: binding.tokenDigest,
    maxOperations: 1,
    record: binding.record
  }), /AUTHORITY_BINDING_DURABLE_MISMATCH/u);
  registerAuthorityBindingRow(table, {
    tokenId: binding.tokenId,
    tokenDigest: binding.tokenDigest,
    maxOperations: 1,
    record: binding.record
  }, true);
  assert.equal(
    table.get<{ readonly record: ActorAxesBindingRecordV2 }>("token:token-1")?.record.active,
    false
  );
  const runtime = createDurableAuthorityBindingRuntimeV2({
    config: { ...config, bootstrapBindings: [] },
    table,
    proofKeys: emptyProofKeys
  });
  const input = {
    tokenId: binding.tokenId,
    maximum: 1,
    opId: "namespace-1:recovery-op"
  };
  assert.equal(await runtime.consumeOperation(input), "denied");
  assert.equal(await runtime.consumeRecoveryOperation!(input), "consumed");
});

const emptyProofKeys: ActorAxesProofKeyResolverV2 = {
  resolve: () => undefined
};

function productionConfig(maxOperations: number): AuthorityProductionRepoConfigV1 {
  return {
    repoId: "repo-1",
    canonicalRoot: "/tmp/repo-1",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    authorityId: "authority-1",
    issuer: "authority.test",
    keyRegistryPath: "/tmp/authority-key-registry.json",
    keyStateDirectory: "/tmp/authority-key-state",
    schemaTuple: {
      wire: 1,
      event: 1,
      receipt: 1,
      digest: 1,
      policy: 1,
      commandRegistry: 1,
      entityRegistry: 1,
      mutationRegistry: 1,
      localState: 1,
      applyJournal: 1
    },
    authorityGeneration: 1,
    revocationEpochs: {
      global: 1n,
      workspace: 1n,
      device: 1n,
      view: 1n,
      principal: 1n,
      executor: 1n
    },
    admissionTokenRef: "token-1",
    allowedExecutorAgentIds: ["agent-1"],
    operationNamespace: {
      schema: "operation-namespace/v1",
      workspaceId: "workspace-1",
      deviceId: "device-1",
      authorityGeneration: 1n,
      namespaceId: "namespace-1",
      expiresAt: 9_999n,
      issuer: "authority.test",
      keyId: "key-1",
      proof: Buffer.alloc(64, 1)
    },
    bootstrapBindings: [{
      tokenId: "token-1",
      tokenDigest: Buffer.alloc(32, 2),
      maxOperations,
      record: bindingRecord()
    }]
  };
}

function bindingRecord(): ActorAxesBindingRecordV2 {
  return {
    bindingId: "binding-1",
    principalPersonId: "person-1",
    executorAgentId: "agent-1",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    active: true,
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person-1" },
        executor: { kind: "agent", id: "agent-1" }
      },
      principalSource: {
        kind: "local-configured",
        authority: "persons.yaml",
        authoritySha256: "a".repeat(64)
      },
      executorSource: "client-asserted"
    }
  };
}

function memoryTable(seed: ReadonlyArray<readonly [string, unknown]> = []): DurableAuthorityStateTable {
  const values = new Map(seed);
  return {
    get: <Value>(key: string) => values.get(key) as Value | undefined,
    put: (key, value) => {
      values.set(key, structuredClone(value));
    },
    entries: <Value>() => [...values.entries()] as ReadonlyArray<readonly [string, Value]>
  };
}
