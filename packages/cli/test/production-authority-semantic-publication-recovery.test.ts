// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AuthorityCommittedReceipt,
  AuthorityOperationRegistry,
  AuthorityStoredOperationRecord,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "../../application/src/index.ts";
import { sha256Text, type makeLocalAuthorityAttributionEventV2Log } from "../../kernel/src/index.ts";
import {
  authorityBatchTrailerName,
  buildAuthorityBatchIntegrity
} from "../../kernel/test/authority-batch-fixture.ts";
import {
  createGitCanonicalPublicationInspector,
  recoverPendingProductionEvents
} from "@harness-anything/daemon";

test("recovery crosses old-to-semantic shape while V2 evidence is delayed without terminalizing the published operation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-recovery-semantic-boundary-"));
  const watermarkPath = path.join(root, "recovery-watermark.json");
  const workspaceId = "workspace-production";
  const oldOpId = "namespace-production:old-shape";
  const opId = "namespace-production:semantic-shape";
  const semanticMutationSetDigest = "c".repeat(64);
  const git = (...args: ReadonlyArray<string>) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test"
    }
  }).trim();
  const semanticMessage = (candidateOpId: string) => {
    const integrity = buildAuthorityBatchIntegrity([{
      opId: candidateOpId,
      semanticMutationSetDigest
    }]);
    return `task(progress-append): task_BOUNDARY progress.md [${candidateOpId}]\n\n${authorityBatchTrailerName}: ${integrity.trailerValue}`;
  };
  const writePublicationFiles = (candidateOpId: string, marker: string) => {
    mkdirSync(path.join(root, "attribution-events"), { recursive: true });
    mkdirSync(path.join(root, "tasks/task_BOUNDARY"), { recursive: true });
    writeFileSync(
      path.join(root, "attribution-events", `${sha256Text(candidateOpId)}.jsonl`),
      `${JSON.stringify({ schema: "attribution-event/v1", opId: candidateOpId })}\n`
    );
    writeFileSync(path.join(root, "tasks/task_BOUNDARY/progress.md"), `${marker}\n`);
  };
  try {
    git("init", "-q", "-b", "master");
    writeFileSync(path.join(root, "seed.txt"), "seed\n");
    git("add", ".");
    git("commit", "-q", "-m", "seed");

    git("checkout", "-q", "-b", "sessions/old");
    writePublicationFiles(oldOpId, "old");
    git("add", ".");
    git("commit", "-q", "-m", semanticMessage(oldOpId));
    git("checkout", "-q", "master");
    git("merge", "-q", "--no-ff", "sessions/old", "-m", "materializer: merge session old");
    const oldMerge = git("rev-parse", "HEAD");

    git("checkout", "-q", "-b", "sessions/semantic");
    writePublicationFiles(opId, "semantic");
    git("add", ".");
    const message = semanticMessage(opId);
    git("commit", "-q", "-m", message);
    git("checkout", "-q", "master");
    git("merge", "-q", "--no-ff", "sessions/semantic", "-m", message);
    const semanticMerge = git("rev-parse", "HEAD");
    writeFileSync(watermarkPath, `${JSON.stringify({
      schema: "authority-recovery-watermark/v1",
      workspaceId,
      commitSha: oldMerge
    })}\n`);

    let durable = pendingRecord(workspaceId, opId, semanticMutationSetDigest);
    let change: ReplicaChangeRecord | undefined;
    let recoveryCount = 0;
    const operationRegistry: AuthorityOperationRegistry = {
      get: async (_workspaceId, candidateOpId) => candidateOpId === opId ? durable : undefined,
      list: async () => [durable],
      put: async (next) => { durable = next; }
    };
    const replicaChangeLog: ReplicaChangeLog = {
      append: async (next) => { change = next; },
      latest: async () => change,
      getByOperation: async (_workspaceId, candidateOpId) =>
        change?.operations.some((operation) => operation.opId === candidateOpId) ? change : undefined,
      changesAfter: async () => change ? [change] : []
    };
    const recover = async (indexed: AuthorityStoredOperationRecord): Promise<AuthorityCommittedReceipt> => {
      recoveryCount += 1;
      return {
        tag: "COMMITTED",
        workspaceId,
        opId,
        semanticDigest: indexed.semanticDigest,
        revision: 1,
        commitSha: semanticMerge,
        previousCommit: oldMerge,
        authorityIntegrity: indexed.authorityIntegrity!
      };
    };
    const input = {
      workspaceId,
      operationRegistry,
      replicaChangeLog,
      eventLog: {} as ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>,
      publicationInspector: createGitCanonicalPublicationInspector(root),
      recover,
      watermarkPath
    };

    await recoverPendingProductionEvents(input);
    await recoverPendingProductionEvents(input);

    assert.equal(recoveryCount, 1, "the delayed V2 window recovers exactly once");
    assert.equal(durable.state, "COMMITTED");
    assert.equal(durable.commitSha, semanticMerge);
    assert.equal(durable.receipt?.tag, "COMMITTED");
    assert.deepEqual(change?.operations.map((operation) => operation.opId), [opId]);
    assert.deepEqual(JSON.parse(readFileSync(watermarkPath, "utf8")), {
      schema: "authority-recovery-watermark/v1",
      workspaceId,
      commitSha: semanticMerge,
      scannedAt: JSON.parse(readFileSync(watermarkPath, "utf8")).scannedAt
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function pendingRecord(
  workspaceId: string,
  opId: string,
  semanticMutationSetDigest: string
): AuthorityStoredOperationRecord {
  const semanticDigest = "a".repeat(64);
  return {
    workspaceId,
    opId,
    semanticDigest,
    state: "INDETERMINATE",
    receipt: {
      tag: "INDETERMINATE",
      workspaceId,
      opId,
      semanticDigest,
      reason: "V2_EVIDENCE_PUBLICATION_DELAYED"
    },
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: semanticDigest,
      semanticMutationSetDigest,
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "d".repeat(64),
      canonicalMutationSet: {
        registryVersion: 1,
        mutations: [{
          entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_BOUNDARY" },
          action: { registryVersion: 1, action: "append" }
        }]
      }
    },
    recordedProtocol: {
      kind: "semantic-mutation-envelope/v2",
      schemaTuple: {
        wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
        commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
      }
    },
    canonicalRequestEnvelope: "durable-envelope"
  };
}
