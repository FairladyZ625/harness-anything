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
  moduleEntityId,
  makeLocalAuthorityAttributionEventV2Log,
  physicalChangeSetDigestV2,
  semanticMutationSetDigestV2,
} from "@harness-anything/kernel";
import { commitTouchedPaths } from "../../packages/kernel/src/write-coordination/journal/publication/git.ts";
import {
  captureAuthoredProjectionFingerprint,
  captureTrustedAuthoredProjectionFingerprint
} from "../../packages/kernel/src/projection/projection-source-baseline.ts";
import { makeLocalVersionControlSystem } from "../../packages/kernel/src/persistence/git/local-version-control-system.ts";
import { rebuildTaskProjection } from "../../packages/kernel/src/projection/sqlite-task-projection.ts";
import { createAuthorityReplicationContentStore } from "../../packages/daemon/src/authority/replication-content-store.ts";
import { createGitAuthorityAttributionEvidenceCommitterV2 } from "../../packages/daemon/src/authority/production/publication-evidence.ts";
import { createDaemonRuntime } from "../../packages/daemon/src/runtime/repo-runtime.ts";
import { createDaemonCommandService } from "../../packages/daemon/src/service/command-service.ts";
import { flushGitCommitPhase } from "../../packages/daemon/src/runtime/repo-write-materializer-telemetry.ts";
import {
  reportCurrentRepoWriteTelemetry,
  runWithRepoWriteTelemetry
} from "../../packages/daemon/src/runtime/repo-write-telemetry-context.ts";

const authoredFileCount = 26_612;
const authoredFileBytes = 5_933;
const taskPackageCount = 1_011;
const evidenceShardCount = 3_179;
const historyCommitCount = 24_000;
const fixtureMaterializerPollMs = 250;
const scratch = mkdtempSync(path.join(tmpdir(), "ha-residual-write-cost-"));
const root = path.join(scratch, "repo");
const authoredRoot = path.join(root, "harness");
const authoredPaths = [];
let pollingRuntime;

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

  // Keep the production queue shape in this fixture: publication is a normal
  // queue item, the materializer poll is a background item, and the legacy
  // command-service barrier is a second background item behind it.
  pollingRuntime = createDaemonRuntime({ rootDir: root, materializerPollMs: fixtureMaterializerPollMs });
  await pollingRuntime.start();

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
      evidenceLog.ensure(v2Event(`op-round7-${String(writeIndex).padStart(2, "0")}`, evidenceShardCount + 1_000 + writeIndex));
      const sessionAttributionPath = authorityEventPath(`op-round7-${String(writeIndex).padStart(2, "0")}`);
      writeFileSync(
        taskIndexPath,
        readFileSync(taskIndexPath, "utf8").replace(/^title:.*$/mu, `title: Synthetic governance write ${writeIndex}`),
        "utf8"
      );
      git("add", authoredPaths[0]);
      let sessionCommit;
      let sessionCommitMs;
      const publication = await pollingRuntime.enqueueAuthorityPublication({
        sessionId,
        publish: async () => {
          report("authority-flush-start");
          const sessionCommitStartedAt = performance.now();
          sessionCommit = commitTouchedPaths(
            root,
            [taskIndexPath, sessionAttributionPath],
            [`op-round7-${String(writeIndex).padStart(2, "0")}`],
            root,
            `synthetic governance write ${writeIndex}`,
            sessionId,
            {
              versionControlSystem: trustedVcs,
              onCommitPhase: (phase) => {
                report(flushGitCommitPhase(phase));
              }
            }
          );
          sessionCommitMs = performance.now() - sessionCommitStartedAt;
          return { reason: "explicit", opCount: 1, committed: true };
        }
      });
      const materializer = publication.materialization;
      if (!materializer || materializer.merged !== 1 || materializer.warnings.length > 0) {
        throw new Error(`fixture materializer did not merge ${sessionBranch}: ${JSON.stringify(materializer)}`);
      }
      const canonicalCommit = git("rev-parse", "HEAD");

      const preAuthorityBarrierMs = await measureBarrierBehindQueuedPoll(
        pollingRuntime,
        sessionId,
        false
      );
      const postAuthorityBarrierMs = await measureBarrierBehindQueuedPoll(
        pollingRuntime,
        sessionId,
        true
      );

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
      report("runtime-event-append-start");
      const runtimeEventReceipt = await pollingRuntime.enqueueInteractiveWrite({
        commandId: `runtime-event-round8-${String(writeIndex).padStart(2, "0")}`,
        operationalActor: { scope: "operational", kind: "system", id: "runtime-event-cli" },
        ops: [runtimeEventOp(
          `runtime-event-round8-${String(writeIndex).padStart(2, "0")}`,
          `${sessionId}.jsonl`,
          `evt-round8-${String(writeIndex).padStart(2, "0")}`
        )]
      });
      if (!runtimeEventReceipt.flush.committed || runtimeEventReceipt.flush.opCount !== 1) {
        throw new Error(`fixture runtime event did not commit: ${JSON.stringify(runtimeEventReceipt.flush)}`);
      }
      report("runtime-event-append-done");
      report("child-execution-returned");
      report("child-telemetry-flushed");
      report("child-terminal-response");
      const telemetry = summarizeTelemetry(telemetryFrames, performance.now() - writeStartedAt);
      trustedFingerprintWrites.push({
        writeIndex,
        sessionCommit,
        sessionCommitMs,
        canonicalCommit,
        materializerMs: telemetry.materializerWindow.durationMs,
        preAuthorityBarrierMs,
        postAuthorityBarrierMs,
        canonicalTrustedMs,
        canonicalFullMs,
        evidenceCommitMs,
        evidenceTrustedMs,
        evidenceFullMs,
        telemetry: compactTelemetry(telemetry)
      });
    });
  }
  await pollingRuntime.stop();
  pollingRuntime = undefined;
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
      historyCommitCount,
      fixtureMaterializerPollMs
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

async function runSessionMaterializationBarrier(runtime, sessionId, authorityBacked) {
  const command = {
    rootDir: root,
    action: {
      kind: "progress-append",
      taskId: "task_synthetic_00000",
      text: "fixture barrier",
      dryRun: false
    }
  };
  const attribution = {
    writeAttribution: {
      actor: {
        principal: { kind: "person", personId: "person_fixture" },
        executor: null
      },
      principalSource: {
        kind: "daemon-authenticated",
        providerId: "fixture",
        credentialFingerprint: "fixture"
      },
      executorSource: "none"
    },
    commitAuthor: { name: "Synthetic Fixture", email: "fixture@example.test" },
    taskHolderPrincipal: {
      personId: "person_fixture",
      displayName: "Synthetic Fixture",
      providerId: "fixture",
      credential: { kind: "unix-socket-owner-boundary", issuer: "fixture", subject: "fixture" }
    },
    executor: null
  };
  const service = createDaemonCommandService(
    runtime,
    {
      parseCommandPayload: (payload) => payload.command,
      normalizeCommand: async (input) => input,
      authorityCommand: authorityBacked ? (input) => input : () => undefined,
      authorityIngressFor: () => undefined,
      repoWriteChildExecutionMode: () => "direct",
      receiptSeed: () => ({ command: "progress append", action: "append" }),
      actorAttribution: () => attribution,
      migrationWriteAttribution: (input) => input,
      isActorAttributionError: () => false,
      isDryRunAction: (input) => input.action.dryRun === true,
      executeCommand: async () => ({ ok: true, command: "progress-append" }),
      materializerCommandResult: (input) => ({ ok: true, command: "materializer", ...input }),
      toReceipt: (input) => input,
      toErrorReceipt: ({ error }) => ({ ok: false, error })
    },
    authorityBacked
      ? { resolveAuthoritySubmissionV2: () => ({ submit: async () => { throw new Error("fixture authority submit"); } }) }
      : {}
  );
  await service.runCommand(
    { command, session: { runtime: "codex", sessionId, source: "runtime", detectedAt: "2026-08-03T00:00:00.000Z" } },
    authorityBacked
      ? {
        actor: { personId: "person_fixture" },
        executor: { kind: "agent", id: "fixture" },
        authorityConnection: { available: true, context: {}, assertActive: () => undefined }
      }
      : undefined
  );
}

async function measureBarrierBehindQueuedPoll(runtime, sessionId, authorityBacked) {
  // A production timer cycle can already be queued when command-service returns
  // from the authority publication. Put the same kind of background item ahead
  // of each comparison barrier so the legacy path measures the queue wait while
  // the authority-backed path proves it does not enqueue a second barrier.
  let pollStarted;
  const pollHasStarted = new Promise((resolve) => {
    pollStarted = resolve;
  });
  const queuedPoll = runtime.enqueueBackgroundBatch({
    source: "fixture-materializer-poll",
    priority: "background",
    run: async () => {
      pollStarted();
      await new Promise((resolve) => setTimeout(resolve, fixtureMaterializerPollMs));
    }
  });
  await pollHasStarted;
  const startedAt = performance.now();
  await runSessionMaterializationBarrier(runtime, sessionId, authorityBacked);
  const elapsedMs = performance.now() - startedAt;
  await queuedPoll;
  return elapsedMs;
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

function compactTelemetry(telemetry) {
  const flushWindow = summarizeNamedWindow(
      telemetry.frames,
      "authority-flush-start",
      "git"
    );
  return {
    wallMs: telemetry.wallMs,
    materializerMs: telemetry.materializerWindow.durationMs,
    projectionSpans: telemetry.materializerWindow.subspansMs.filter((span) =>
      span.from.includes("projection") || span.to.includes("projection")
    ),
    flushMs: flushWindow.durationMs,
    flushSpansOver10ms: flushWindow.subspansMs.filter((span) => span.milliseconds >= 10),
    evidenceTailMs: telemetry.evidenceToChildTail.durationMs,
    postTerminal: summarizeNamedWindow(
      telemetry.frames,
      "authority-terminal-record-persisted",
      "child-execution-returned"
    ),
    postCommitSpans: telemetry.frames
      .filter((frame) => frame.phase.startsWith("authority-flush-post-commit-"))
      .map((frame, index, frames) => ({
        phase: frame.phase,
        elapsedMs: frame.elapsedMs,
        deltaFromPreviousPostCommitMs: index === 0 ? undefined : frame.elapsedMs - frames[index - 1].elapsedMs
      })),
    projectionMode: telemetry.frames
      .filter((frame) => frame.phase.startsWith("authority-materializer-projection-mode-"))
      .map((frame) => frame.phase),
    wallResidualMs: telemetry.accounting.wallResidualMs
  };
}

function summarizeNamedWindow(frames, startPhase, endPhase) {
  const startIndex = frames.findIndex((frame) => frame.phase === startPhase);
  const endIndex = frames.findIndex((frame, index) => index > startIndex && frame.phase === endPhase);
  return summarizeWindow(frames, startIndex, endIndex);
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

function runtimeEventOp(opId, fileName, eventId) {
  return {
    opId,
    entityId: moduleEntityId("runtime-event-ledger"),
    kind: "machine_artifact_append_jsonl",
    payload: {
      boundary: "runtime-event-ledger",
      path: `.harness/generated/runtime-events/${fileName}`,
      value: { schema: "runtime-event/v1", eventId }
    }
  };
}

function hex(value) {
  return Buffer.from(value).toString("hex");
}
