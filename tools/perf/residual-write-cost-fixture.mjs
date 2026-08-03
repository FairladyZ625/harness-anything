import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  actorAxesBindingCoreDigestV2,
  canonicalAttributionEventDigestV2,
  makeLocalAuthorityAttributionEventV2Log,
  physicalChangeSetDigestV2,
  semanticMutationSetDigestV2
} from "@harness-anything/kernel";
import { captureAuthoredProjectionFingerprint } from "../../packages/kernel/src/projection/projection-source-baseline.ts";
import { createAuthorityReplicationContentStore } from "../../packages/daemon/src/authority/replication-content-store.ts";
import { createGitAuthorityAttributionEvidenceCommitterV2 } from "../../packages/daemon/src/authority/production/publication-evidence.ts";

const authoredFileCount = 26_612;
const authoredFileBytes = 5_933;
const taskPackageCount = 1_011;
const evidenceShardCount = 3_179;
const historyCommitCount = 24_000;
const scratch = mkdtempSync(path.join(tmpdir(), "ha-residual-write-cost-"));
const root = path.join(scratch, "repo");
const authoredRoot = path.join(root, "harness");
const authoredPaths = [];

try {
  mkdirSync(authoredRoot, { recursive: true });
  git("init", "-q");
  git("config", "user.name", "Synthetic Fixture");
  git("config", "user.email", "fixture@example.test");
  seedAuthoredTree();
  git("add", ".");
  git("commit", "-q", "-m", "synthetic authored baseline");
  seedHistory();

  const evidenceLog = makeLocalAuthorityAttributionEventV2Log(root);
  for (let index = 0; index < evidenceShardCount; index += 1) {
    evidenceLog.ensure(v2Event(`op-history-${String(index).padStart(5, "0")}`, index + 1));
  }
  git("add", ".");
  git("commit", "-q", "-m", "synthetic evidence baseline");
  const previousCommit = git("rev-parse", "HEAD");
  const evidenceCommitter = createGitAuthorityAttributionEvidenceCommitterV2(root);
  await evidenceCommitter.commitPending(previousCommit);

  const fingerprintMs = measure(() => captureAuthoredProjectionFingerprint(root));
  const values = new Map();
  const state = {
    get: (key) => values.get(key),
    put: (key, value) => values.set(key, structuredClone(value)),
    entries: () => [...values.entries()]
  };
  const replication = createAuthorityReplicationContentStore({
    gitRoot: authoredRoot,
    state,
    workspaceId: "workspace-synthetic",
    epoch: "1"
  });
  replication.snapshot(previousCommit, 1);

  const changedRelativePath = authoredPaths.at(-1);
  writeAuthoredFile(changedRelativePath, authoredFileCount + 1, "# Changed synthetic payload\n");
  git("add", changedRelativePath);
  git("commit", "-q", "-m", "synthetic one-file change");
  const canonicalCommit = git("rev-parse", "HEAD");
  const replicationMs = measure(() => replication.describeChange({
    schema: "replica-change/v1",
    workspaceId: "workspace-synthetic",
    revision: 2,
    opId: "op-current",
    semanticDigest: "55".repeat(32),
    commitSha: canonicalCommit,
    previousCommit,
    changedAt: "2026-08-03T00:00:00.000Z"
  }));
  const evidenceVerifyMs = measure(() => evidenceLog.verifyIntegrity());
  const pending = evidenceLog.ensure(v2Event("op-pending", evidenceShardCount + 1));
  const pendingShard = path.basename(authorityEventPath("op-pending"));
  const pendingVerifyMs = measure(() => evidenceLog.verifyShards([pendingShard]));
  if (pending.replayed) throw new Error("synthetic pending evidence unexpectedly replayed");
  invalidateIndexStats();
  const evidenceCommitStartedAt = performance.now();
  await evidenceCommitter.commitPending(canonicalCommit);
  const evidenceCommitMs = performance.now() - evidenceCommitStartedAt;

  console.log(JSON.stringify({
    schema: "residual-write-cost-fixture/v1",
    shape: {
      authoredFileCount,
      authoredMiB: authoredFileCount * authoredFileBytes / 1_048_576,
      taskPackageCount,
      evidenceShardCount,
      historyCommitCount
    },
    phasesMs: {
      projectionFingerprint: fingerprintMs,
      replicationDescribeOneFileChange: replicationMs,
      evidenceHistoryVerify: evidenceVerifyMs,
      evidencePendingShardVerify: pendingVerifyMs,
      evidenceCommitAfterHeadAdvanceAndInvalidatedIndex: evidenceCommitMs
    }
  }, null, 2));
} finally {
  if (process.env.KEEP_RESIDUAL_WRITE_COST_FIXTURE === "1") {
    console.error(`fixture retained at ${scratch}`);
  } else {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function seedAuthoredTree() {
  for (let taskIndex = 0; taskIndex < taskPackageCount; taskIndex += 1) {
    const taskId = `task_synthetic_${String(taskIndex).padStart(5, "0")}`;
    for (const document of ["INDEX.md", "facts.md", "module.md", "review.md", "closeout.md"]) {
      const relativePath = path.join("tasks", taskId, document);
      authoredPaths.push(relativePath);
      writeAuthoredFile(relativePath, authoredPaths.length - 1, document === "INDEX.md"
        ? `---\ntitle: Synthetic ${taskIndex}\nstatus: done\n---\n`
        : `# ${document} ${taskIndex}\n`);
    }
  }
  while (authoredPaths.length < authoredFileCount) {
    const index = authoredPaths.length;
    const relativePath = path.join(
      "bulk",
      String(Math.floor(index / 128)).padStart(4, "0"),
      `${String(index).padStart(5, "0")}.md`
    );
    authoredPaths.push(relativePath);
    writeAuthoredFile(relativePath, index, "# Synthetic authored payload\n");
  }
}

function writeAuthoredFile(relativePath, uniqueIndex, prefix) {
  const unique = `${prefix}fixture-index:${String(uniqueIndex).padStart(8, "0")}\n`;
  const body = `${unique}${"a".repeat(Math.max(0, authoredFileBytes - Buffer.byteLength(unique)))}`;
  const absolutePath = path.join(authoredRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, body);
}

function seedHistory() {
  const start = git("rev-parse", "HEAD");
  let stream = "feature done\n";
  for (let index = 1; index <= historyCommitCount; index += 1) {
    const message = `synthetic history ${index}`;
    stream += "commit refs/heads/master\n";
    stream += `mark :${index}\n`;
    stream += `committer Synthetic Fixture <fixture@example.test> ${1_700_000_000 + index} +0000\n`;
    stream += `data ${Buffer.byteLength(message)}\n${message}\n`;
    stream += index === 1 ? `from ${start}\n` : `from :${index - 1}\n`;
  }
  stream += "done\n";
  execFileSync("git", ["-C", authoredRoot, "fast-import", "--quiet"], {
    input: stream,
    stdio: ["pipe", "ignore", "pipe"]
  });
}

function invalidateIndexStats() {
  const changed = new Date(Date.now() + 2_000);
  for (const relativePath of authoredPaths) {
    utimesSync(path.join(authoredRoot, relativePath), changed, changed);
  }
}

function authorityEventPath(opId) {
  const digest = Buffer.from(
    // The product key is stable and content-independent; ask Git for the new
    // shard rather than duplicating that digest protocol in this benchmark.
    git("ls-files", "--others", "--exclude-standard", "-z"),
    "utf8"
  );
  const candidates = digest.toString("utf8").split("\0").filter((entry) => entry.endsWith(".jsonl"));
  if (candidates.length !== 1) throw new Error(`expected one pending shard for ${opId}, received ${candidates.length}`);
  return path.join(authoredRoot, candidates[0]);
}

function measure(operation) {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

function git(...args) {
  return execFileSync("git", ["-C", authoredRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function v2Event(opId, revision) {
  const mutationSet = {
    registryVersion: 1,
    mutations: [{
      entity: { registryVersion: 1, entityKind: "fact", canonicalRef: `fact/task_T/${opId}` },
      action: { registryVersion: 1, action: "create" }
    }]
  };
  const actorAxesBinding = {
    bindingId: "binding-synthetic",
    principalPersonId: "person_fixture",
    executorAgentId: "agent-fixture",
    workspaceId: "workspace-synthetic",
    deviceId: "device-synthetic",
    viewId: "view-synthetic",
    sessionId: "session-synthetic",
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
      commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
      localState: 1, applyJournal: 1
    }
  };
  const physicalChanges = [{
    path: `tasks/task_T/${opId}.md`,
    beforeDigest: "11".repeat(32),
    afterDigest: "22".repeat(32)
  }];
  const withoutEventDigest = {
    schema: "attribution-event/v2",
    eventId: `attribution:${opId}`,
    workspaceId: "workspace-synthetic",
    opId,
    revision,
    commitSha: "commit-v2",
    previousCommit: "commit-v1",
    outcome: "COMMITTED",
    occurredAt: "2026-08-03T00:00:00.000Z",
    recordedAt: "2026-08-03T00:00:00.100Z",
    actorAxesBinding,
    semanticRequestDigest: "33".repeat(32),
    mutationSet,
    semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
    actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
    physicalChanges,
    changeSetDigest: hex(physicalChangeSetDigestV2(physicalChanges))
  };
  return {
    ...withoutEventDigest,
    canonicalEventDigest: hex(canonicalAttributionEventDigestV2(withoutEventDigest))
  };
}

function hex(value) {
  return Buffer.from(value).toString("hex");
}
