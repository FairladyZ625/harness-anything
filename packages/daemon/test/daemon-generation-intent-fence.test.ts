// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorityProtocolTuple,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  type AuthorityOperationEnvelope
} from "@harness-anything/application";
import {
  createDaemonGenerationAuthorityFence,
  createDaemonGenerationWitness,
  daemonGenerationFencedCode,
  publishNextDaemonGeneration,
  readOrCreateDaemonMachineId
} from "../src/index.ts";

const intentFencePosixOnly = process.platform === "win32"
  ? "durable generation publication is unsupported on Windows"
  : false;

test("replacement between the admission check and RECEIVED persistence leaves no stale intent", {
  skip: intentFencePosixOnly
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-generation-received-race-"));
  try {
    const endpointIdentity = path.join(root, "daemon.sock");
    const machineId = readOrCreateDaemonMachineId(root);
    const first = publishNextDaemonGeneration({
      userRoot: root,
      endpointIdentity,
      machineId,
      daemonInstanceId: "daemon-before-received"
    });
    const generationFence = createDaemonGenerationAuthorityFence({
      authorityFence: { assertHeld: async () => undefined },
      generationWitness: createDaemonGenerationWitness({
        userRoot: root,
        endpointIdentity,
        machineId,
        daemonGeneration: first.daemonGeneration
      }),
      workspaceId: "workspace-received-race",
      repo: { repoId: "repo-received-race", canonicalRoot: root },
      connectionId: "connection-received-race"
    });
    const memory = createInMemoryAuthorityOperationRegistry();
    let replacementPublished = false;
    const service = createAuthoritySubmissionService({
      workspaceId: "workspace-received-race",
      coordinatorFactory: {
        create: () => { throw new Error("stale admission must not construct a coordinator"); }
      },
      tokenVerifier: { verify: async () => { throw new Error("stale admission must not verify a token"); } },
      operationRegistry: {
        list: memory.list,
        put: memory.put,
        get: async (workspaceId, opId) => {
          const known = await memory.get(workspaceId, opId);
          if (!replacementPublished) {
            replacementPublished = true;
            publishNextDaemonGeneration({
              userRoot: root,
              endpointIdentity,
              machineId,
              daemonInstanceId: "daemon-after-received-check"
            });
          }
          return known;
        }
      },
      replicaChangeLog: createInMemoryReplicaChangeLog(),
      publicationInspector: {
        currentHead: async () => null,
        inspectPublishedHead: async () => { throw new Error("stale admission must not inspect publication"); }
      },
      fenceWitness: { assertHeld: async () => undefined },
      generationFenceWitness: generationFence
    });

    const receipt = await service.submit(receivedRaceEnvelope());

    assert.equal(receipt.tag, "RETRYABLE_NOT_COMMITTED");
    assert.equal(receipt.tag === "RETRYABLE_NOT_COMMITTED" ? receipt.errorCode : undefined, daemonGenerationFencedCode);
    assert.deepEqual(await memory.list("workspace-received-race"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function receivedRaceEnvelope(): AuthorityOperationEnvelope {
  return {
    workspaceId: "workspace-received-race",
    opId: "op-received-race",
    claimedDigest: "a".repeat(64),
    command: "task.progress.append",
    operation: {
      opId: "op-received-race",
      entityId: "task/task_RECEIVED_RACE",
      kind: "progress_append",
      payload: { path: "progress.md", append: "stale\n" }
    },
    delegationToken: "stale-token",
    channelNonceDigest: "b".repeat(64),
    protocol: authorityProtocolTuple
  };
}
