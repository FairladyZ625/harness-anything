import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  semanticMutationSetDigestV2,
  runLedgerMaterializer
} from "@harness-anything/kernel";
import {
  captureAuthoredProjectionFingerprint,
  captureTrustedAuthoredProjectionFingerprint
} from "../../packages/kernel/src/projection/projection-source-baseline.ts";
import { makeLocalVersionControlSystem } from "../../packages/kernel/src/persistence/git/local-version-control-system.ts";
import { rebuildTaskProjection } from "../../packages/kernel/src/projection/sqlite-task-projection.ts";
import { createAuthorityReplicationContentStore } from "../../packages/daemon/src/authority/replication-content-store.ts";
import { createGitAuthorityAttributionEvidenceCommitterV2 } from "../../packages/daemon/src/authority/production/publication-evidence.ts";
import {
  reportCurrentRepoWriteTelemetry,
  runWithRepoWriteTelemetry
} from "../../packages/daemon/src/runtime/repo-write-telemetry-context.ts";

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
  const projectionRebuildMs = measure(() => rebuildTaskProjection({ rootDir: root }));
  const trustedVcs = makeLocalVersionControlSystem();
  const trustedFingerprintColdMs = measure(() => captureTrustedAuthoredProjectionFingerprint(root, trustedVcs));
  const trustedFingerprintWrites = [];
  for (let writeIndex = 1; writeIndex <= 2; writeIndex += 1) {
    const writeStartedAt = performance.now();
    const telemetryFrames = [];
    await runWithRepoWriteTelemetry((phase, elapsedMs) => {
      telemetryFrames.push({ phase, elapsedMs });
    }, async () => {
      const report = (phase) => reportCurrentRepoWriteTelemetry(phase);
      report("queue");
      report("compile");
      report("journal");
      const sessionId = `round6-write-${writeIndex}`;
      const sessionBranch = `sessions/${sessionId}`;
      const taskIndexPath = path.join(authoredRoot, authoredPaths[0]);
      git("branch", sessionBranch);
      git("checkout", sessionBranch);
      writeFileSync(
        taskIndexPath,
        readFileSync(taskIndexPath, "utf8").replace(/^title:.*$/mu, `title: Synthetic governance write ${writeIndex}`),
        "utf8"
      );
      git("add", authoredPaths[0]);
      const sessionCommitStartedAt = performance.now();
      git("commit", "-q", "-m", `synthetic governance write ${writeIndex}`);
      const sessionCommitMs = performance.now() - sessionCommitStartedAt;
      const sessionCommit = git("rev-parse", "HEAD");
      git("checkout", "master");

      report("authority-flush-start");
      report("git");
      report("fsync");
      report("authority-materializer-start");
      const materializerStartedAt = performance.now();
      const materializer = runLedgerMaterializer(root, {
        sessionId,
        versionControlSystem: trustedVcs,
        onProgress: (step) => report(materializerTelemetryPhase(step))
      });
      const materializerMs = performance.now() - materializerStartedAt;
      report("authority-materializer-end");
      report("total");
      if (materializer.merged !== 1 || materializer.warnings.length > 0) {
        throw new Error(`fixture materializer did not merge ${sessionBranch}: ${JSON.stringify(materializer)}`);
      }
      const canonicalCommit = git("rev-parse", "HEAD");

      const canonicalTrustedStartedAt = performance.now();
      const canonicalTrustedFingerprint = captureTrustedAuthoredProjectionFingerprint(root, trustedVcs);
      const canonicalTrustedMs = performance.now() - canonicalTrustedStartedAt;
      const canonicalFullStartedAt = performance.now();
      const canonicalFullFingerprint = captureAuthoredProjectionFingerprint(root);
      const canonicalFullMs = performance.now() - canonicalFullStartedAt;
      if (canonicalTrustedFingerprint !== canonicalFullFingerprint) {
        throw new Error(`trusted fingerprint mismatch after canonical write ${writeIndex}`);
      }

      report("authority-evidence-commit");
      report("fsync");
      evidenceLog.ensure(v2Event(`op-round6-${String(writeIndex).padStart(2, "0")}`, evidenceShardCount + writeIndex));
      const evidenceCommitStartedAt = performance.now();
      await evidenceCommitter.commitPending(canonicalCommit);
      const evidenceCommitMs = performance.now() - evidenceCommitStartedAt;
      report("authority-evidence-publish-returned");
      report("authority-event-published");
      const evidenceTrustedStartedAt = performance.now();
      const evidenceTrustedFingerprint = captureTrustedAuthoredProjectionFingerprint(root, trustedVcs);
      const evidenceTrustedMs = performance.now() - evidenceTrustedStartedAt;
      const evidenceFullStartedAt = performance.now();
      const evidenceFullFingerprint = captureAuthoredProjectionFingerprint(root);
      const evidenceFullMs = performance.now() - evidenceFullStartedAt;
      if (evidenceTrustedFingerprint !== evidenceFullFingerprint) {
        throw new Error(`trusted fingerprint mismatch after evidence write ${writeIndex}`);
      }
      report("authority-terminal-record-start");
      report("authority-terminal-record-persisted");
      report("child-execution-returned");
      report("child-telemetry-flushed");
      report("child-terminal-response");
      trustedFingerprintWrites.push({
        writeIndex,
        sessionCommit,
        sessionCommitMs,
        canonicalCommit,
        materializerMs,
        canonicalTrustedMs,
        canonicalFullMs,
        evidenceCommitMs,
        evidenceTrustedMs,
        evidenceFullMs,
        telemetry: summarizeTelemetry(telemetryFrames, performance.now() - writeStartedAt)
      });
    });
  }
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
  const replicationPreviousCommit = git("rev-parse", "HEAD");
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
    previousCommit: replicationPreviousCommit,
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
      projectionRebuild: projectionRebuildMs,
      trustedFingerprintCold: trustedFingerprintColdMs,
      replicationDescribeOneFileChange: replicationMs,
      evidenceHistoryVerify: evidenceVerifyMs,
      evidencePendingShardVerify: pendingVerifyMs,
      evidenceCommitAfterHeadAdvanceAndInvalidatedIndex: evidenceCommitMs,
      trustedFingerprintWrites
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

function materializerTelemetryPhase(step) {
  const phases = {
    "baseline-start": "authority-materializer-baseline-start",
    "baseline-done": "authority-materializer-baseline-done",
    "merge-start": "authority-materializer-merge-start",
    "merge-done": "authority-materializer-merge-done",
    "projection-start": "authority-materializer-projection-start",
    "projection-done": "authority-materializer-projection-done",
    "attribution-start": "authority-materializer-attribution-start",
    "attribution-done": "authority-materializer-attribution-done"
  };
  const phase = phases[step];
  if (!phase) throw new Error(`unknown materializer telemetry step: ${step}`);
  return phase;
}

function summarizeTelemetry(frames, wallMs) {
  const ordered = frames.map((frame, index) => ({ ...frame, index }));
  const firstTotalIndex = ordered.findIndex((frame) => frame.phase === "total");
  const firstFsyncBeforeTotalIndex = ordered.findLastIndex(
    (frame, index) => index < firstTotalIndex && frame.phase === "fsync"
  );
  const evidenceDoneIndex = ordered.findLastIndex((frame) => frame.phase === "authority-evidence-git-commit-done");
  const childTerminalIndex = ordered.findLastIndex((frame) => frame.phase === "child-terminal-response");
  const materializerWindow = summarizeWindow(ordered, firstFsyncBeforeTotalIndex, firstTotalIndex);
  const evidenceTail = summarizeWindow(ordered, evidenceDoneIndex, childTerminalIndex);
  const firstElapsedMs = ordered[0]?.elapsedMs ?? 0;
  const lastElapsedMs = ordered.at(-1)?.elapsedMs ?? 0;
  const beforeFirstFrameMs = Math.max(0, firstElapsedMs);
  const framedSpanMs = Math.max(0, lastElapsedMs - firstElapsedMs);
  const afterLastFrameMs = Math.max(0, wallMs - lastElapsedMs);
  return {
    frameCount: frames.length,
    frames,
    wallMs,
    materializerWindow,
    evidenceToChildTail: evidenceTail,
    accounting: {
      beforeFirstFrameMs,
      framedSpanMs,
      afterLastFrameMs,
      accountedWallMs: beforeFirstFrameMs + framedSpanMs + afterLastFrameMs,
      wallResidualMs: wallMs - (beforeFirstFrameMs + framedSpanMs + afterLastFrameMs)
    }
  };
}

function summarizeWindow(frames, startIndex, endIndex) {
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    return { found: false, durationMs: 0, subspansMs: [] };
  }
  const start = frames[startIndex];
  const end = frames[endIndex];
  const subspansMs = [];
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    subspansMs.push({
      from: frames[index - 1].phase,
      to: frames[index].phase,
      milliseconds: frames[index].elapsedMs - frames[index - 1].elapsedMs
    });
  }
  return {
    found: true,
    from: start.phase,
    to: end.phase,
    durationMs: end.elapsedMs - start.elapsedMs,
    subspansMs,
    subspansTotalMs: subspansMs.reduce((total, span) => total + span.milliseconds, 0)
  };
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
