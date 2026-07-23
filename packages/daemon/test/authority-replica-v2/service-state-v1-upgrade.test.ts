// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stableStringify } from "../../../kernel/src/index.ts";
import type { AuthorityOperationIntegrity } from "../../../application/src/index.ts";
import { openDurableAuthorityServiceState } from "../../src/index.ts";

test("durable service state upgrades a real replica-change/v1 JSONL row before lookup and append", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-v1-upgrade-"));
  try {
    const repoId = "canonical";
    const stateDirectory = path.join(root, "authority", Buffer.from(repoId, "utf8").toString("base64url"));
    mkdirSync(stateDirectory, { recursive: true });
    const legacy = {
      schema: "replica-change/v1",
      workspaceId: "workspace-upgrade",
      revision: 1,
      opId: "op-v1",
      semanticDigest: "digest-v1",
      commitSha: "commit-1",
      previousCommit: null,
      changedAt: "2026-07-23T00:00:00.000Z",
      authorityIntegrity: operationIntegrity("a")
    };
    writeFileSync(path.join(stateDirectory, "replica-changes.jsonl"), `${stableStringify({
      schema: "authority-service-state/v1",
      table: "replica-change",
      key: "workspace-upgrade\0" + "1",
      value: legacy
    })}\n`);

    const state = openDurableAuthorityServiceState({ serviceStateRoot: root, repoId });
    const upgraded = await state.replicaChangeLog.getByOperation("workspace-upgrade", "op-v1");
    assert.equal(upgraded?.schema, "replica-change/v2");
    assert.deepEqual(upgraded?.operations, [{
      opId: "op-v1",
      semanticDigest: "digest-v1",
      authorityIntegrity: legacy.authorityIntegrity
    }]);
    assert.equal(upgraded?.opId, upgraded?.operations[0]?.opId);
    assert.equal(upgraded?.semanticDigest, upgraded?.operations[0]?.semanticDigest);
    assert.deepEqual(upgraded?.authorityIntegrity, upgraded?.operations[0]?.authorityIntegrity);
    await state.replicaChangeLog.append({
      schema: "replica-change/v2",
      workspaceId: "workspace-upgrade",
      revision: 2,
      opId: "op-v2",
      semanticDigest: "digest-v2",
      operations: [{ opId: "op-v2", semanticDigest: "digest-v2" }],
      commitSha: "commit-2",
      previousCommit: "commit-1",
      changedAt: "2026-07-23T00:00:01.000Z"
    });
    assert.equal((await state.replicaChangeLog.latest("workspace-upgrade"))?.revision, 2);
    await state.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable replica changes enforce the operations[0] aliases at empty, single, and multi-operation boundaries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-alias-boundaries-"));
  const state = openDurableAuthorityServiceState({ serviceStateRoot: root, repoId: "canonical" });
  try {
    await assert.rejects(state.replicaChangeLog.append({
      schema: "replica-change/v2",
      workspaceId: "workspace-alias",
      revision: 1,
      opId: "op-empty",
      semanticDigest: "digest-empty",
      operations: [],
      commitSha: "commit-empty",
      previousCommit: null,
      changedAt: "2026-07-23T00:00:00.000Z"
    }), /AUTHORITY_REPLICA_CHANGE_OPERATION_GROUP_INVALID/);

    const integrityA = operationIntegrity("a");
    await state.replicaChangeLog.append({
      schema: "replica-change/v2",
      workspaceId: "workspace-alias",
      revision: 1,
      opId: "op-a",
      semanticDigest: "digest-a",
      operations: [{ opId: "op-a", semanticDigest: "digest-a", authorityIntegrity: integrityA }],
      commitSha: "commit-a",
      previousCommit: null,
      changedAt: "2026-07-23T00:00:01.000Z",
      authorityIntegrity: integrityA
    });

    await assert.rejects(state.replicaChangeLog.append({
      schema: "replica-change/v2",
      workspaceId: "workspace-alias",
      revision: 2,
      opId: "op-b",
      semanticDigest: "wrong-top-level-alias",
      operations: [
        { opId: "op-b", semanticDigest: "digest-b" },
        { opId: "op-c", semanticDigest: "digest-c" }
      ],
      commitSha: "commit-bc",
      previousCommit: "commit-a",
      changedAt: "2026-07-23T00:00:02.000Z"
    }), /AUTHORITY_REPLICA_CHANGE_OPERATION_GROUP_INVALID/);

    await state.replicaChangeLog.append({
      schema: "replica-change/v2",
      workspaceId: "workspace-alias",
      revision: 2,
      opId: "op-b",
      semanticDigest: "digest-b",
      operations: [
        { opId: "op-b", semanticDigest: "digest-b" },
        { opId: "op-c", semanticDigest: "digest-c" }
      ],
      commitSha: "commit-bc",
      previousCommit: "commit-a",
      changedAt: "2026-07-23T00:00:03.000Z"
    });
    const multi = await state.replicaChangeLog.getByOperation("workspace-alias", "op-c");
    assert.equal(multi?.opId, multi?.operations[0]?.opId);
    assert.equal(multi?.semanticDigest, multi?.operations[0]?.semanticDigest);
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function operationIntegrity(digestByte: string): AuthorityOperationIntegrity {
  return {
    schema: "authority-operation-integrity/v2",
    semanticRequestDigest: digestByte.repeat(64),
    semanticMutationSetDigest: digestByte.repeat(64),
    mutationRegistryVersion: 1,
    actorAxesBindingDigest: "f".repeat(64),
    canonicalMutationSet: { registryVersion: 1, mutations: [] }
  };
}
