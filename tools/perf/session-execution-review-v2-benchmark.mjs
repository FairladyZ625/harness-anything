import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { Effect } from "effect";
import {
  canonicalAuthorityRequestDigest,
  canonicalPayloadDigestV2,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog,
  encodeSessionExecutionReviewCommandPayloadV2,
  makeSessionExecutionReviewSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2
} from "../../packages/application/src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry,
  makeJournaledWriteCoordinator,
  sha256Text
} from "../../packages/kernel/src/index.ts";

const writerCounts = integerListOption("--writers", [2, 4, 8]);
const rounds = integerOption("--rounds", 10);
const groups = enumListOption("--groups", ["session-cas-blob", "hosted-small-op"], ["session-cas-blob", "hosted-small-op"]);
const blobBytes = integerOption("--blob-bytes", 64 * 1024);
const workspaceId = "workspace-w4-perf";
const token = "w4-perf-token";
const channelNonceDigest = "sha256:w4-perf-channel";
const protocol = { wire: 1, event: 1, receipt: 1, digest: 1, commandRegistry: 1 };
const scenarios = [];

for (const group of groups) {
  for (const writers of writerCounts) scenarios.push(await runScenario(group, writers));
}

process.stdout.write(`${JSON.stringify({
  schema: "session-execution-review-v2-concurrency-benchmark/v1",
  measuredAt: new Date().toISOString(),
  sourceCommit: gitAt(process.cwd(), "rev-parse", "HEAD"),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  workload: "session composite manifest+CAS blob; disjoint execution/review hosted documents",
  rounds,
  blobBytes,
  thresholds: { writer8AbsoluteP95Ms: 2_000, frozenA1P95Ms: 1_352, maxFrozenBaselineDegradationRatio: 1.2 },
  scenarios
}, null, 2)}\n`);

async function runScenario(group, writers) {
  return withGit(group, writers, async ({ rootDir, env }) => {
    const queueWaitByOp = new Map();
    const submitStartedByOp = new Map();
    const service = authority(rootDir, env, queueWaitByOp, submitStartedByOp);
    const compiler = makeSessionExecutionReviewSemanticCompilerV2({
      state: { readEntityBase: async () => null, readHostedDocument: async () => null }
    });
    const registry = createWritableEntityRegistry([entityRegistry.session, entityRegistry.execution, entityRegistry.review]);
    const samples = { endToEndMs: [], compilerMs: [], queueWaitMs: [], commitIndexMs: [] };
    for (let round = 0; round < rounds; round += 1) {
      const rows = await Promise.all(Array.from({ length: writers }, async (_, writer) => {
        const fixture = operationFixture(group, writers, round, writer);
        const started = performance.now();
        const compileStarted = performance.now();
        const semantic = await compiler.compile(fixture.envelope);
        const compiled = compileRegistryMutationPlan(registry, semantic.mutationPlan);
        const compilerMs = performance.now() - compileStarted;
        const expectedTargets = group === "session-cas-blob" ? 2 : 1;
        if (compiled.mutationSet.mutations.length !== 1 || compiled.storagePlan.targets.length !== expectedTargets) {
          throw new Error("W4 benchmark compiler produced an unexpected mutation or StoragePlan target count");
        }
        submitStartedByOp.set(fixture.opId, performance.now());
        const receipt = await service.submit(v1Envelope(fixture.opId, { ...semantic.operation, opId: fixture.opId }));
        const endToEndMs = performance.now() - started;
        if (receipt.tag !== "COMMITTED") throw new Error(`${fixture.opId} returned ${receipt.tag}`);
        const queueWaitMs = queueWaitByOp.get(fixture.opId);
        if (queueWaitMs === undefined) throw new Error(`queue wait missing for ${fixture.opId}`);
        return { endToEndMs, compilerMs, queueWaitMs, commitIndexMs: Math.max(0, endToEndMs - compilerMs - queueWaitMs) };
      }));
      for (const row of rows) for (const key of Object.keys(samples)) samples[key].push(row[key]);
    }
    const endToEnd = summary(samples.endToEndMs);
    return {
      group,
      writers,
      attempts: samples.endToEndMs.length,
      endToEndMs: endToEnd,
      gate: {
        absoluteP95Pass: writers !== 8 || endToEnd.p95Ms < 2_000,
        frozenBaselinePass: endToEnd.p95Ms < 1_352 * 1.2
      },
      segments: {
        registryCompileSemanticDiffMs: summary(samples.compilerMs),
        coordinatorQueueWaitMs: summary(samples.queueWaitMs),
        commitIndexMs: summary(samples.commitIndexMs)
      }
    };
  });
}

function operationFixture(group, writers, round, writer) {
  const ordinal = round * writers + writer;
  const suffix = `${group}-n${writers}-r${round}-w${writer}`;
  let payloadValue;
  let entityKind;
  let canonicalRef;
  if (group === "session-cas-blob") {
    const sessionId = `session-w4-perf-${writers}-${ordinal}`;
    const body = fixedBody(blobBytes, suffix);
    payloadValue = { schema: "session.export/v1", manifest: sessionManifest(sessionId, body), body };
    entityKind = "session";
    canonicalRef = `session/${sessionId}`;
  } else {
    const taskId = `task_${stableId(writers * 100_000 + ordinal + 1)}`;
    const executionId = `exe_${stableId(writers * 200_000 + ordinal + 1)}`;
    if (writer % 2 === 0) {
      payloadValue = { schema: "execution.claim/v1", taskId, execution: executionRecord(taskId, executionId) };
      entityKind = "execution";
      canonicalRef = `execution/${taskId}/${executionId}`;
    } else {
      const reviewId = `rev_${stableId(writers * 300_000 + ordinal + 1)}`;
      payloadValue = { schema: "review.record/v1", taskId, review: reviewRecord(taskId, executionId, reviewId) };
      entityKind = "review";
      canonicalRef = `review/${taskId}/${reviewId}`;
    }
  }
  const payload = encodeSessionExecutionReviewCommandPayloadV2(payloadValue);
  const mutationSet = { registryVersion: 1, mutations: [] };
  const draft = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId,
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId, deviceId: "device-w4-perf", authorityGeneration: 1n,
        namespaceId: "namespace-w4-perf", expiresAt: 9_000n, issuer: "authority.perf", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.from(fixedHex(ordinal + (group === "session-cas-blob" ? 1 : 1_000_000), 32), "hex")
    },
    binding: {
      bindingId: "binding-w4-perf", actorAxesBindingDigest: Buffer.alloc(32, 4), deviceId: "device-w4-perf",
      viewId: "view-w4-perf", sessionId: "session-w4-perf",
      admissionTokenRef: { tokenId: "token-w4-perf", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
      commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
    },
    intent: {
      kind: "typed", command: { registryVersion: 1, name: payloadValue.schema.replace("/v1", ""), version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas: [{
        entityRef: { registryVersion: 1, entityKind, canonicalRef },
        expectedSemanticVersion: null, expectedStateDigest: null
      }],
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return { opId: `w4-perf-${suffix}`, envelope: { ...draft, claimedSemanticRequestDigest: semanticRequestDigestV2(draft) } };
}

function authority(rootDir, env, queueWaitByOp, submitStartedByOp) {
  return createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => {
        const coordinator = makeJournaledWriteCoordinator({
          rootDir, attribution, commitAuthor: { name: "W4 Benchmark", email: "benchmark@example.test" }, autoMaterialize: false
        });
        return {
          enqueue: (operation) => Effect.gen(function* () {
            const started = submitStartedByOp.get(operation.opId);
            if (started === undefined) throw new Error(`submit start missing for ${operation.opId}`);
            queueWaitByOp.set(operation.opId, performance.now() - started);
            return yield* coordinator.enqueue(operation);
          }),
          flush: coordinator.flush,
          recover: coordinator.recover
        };
      }
    },
    tokenVerifier: {
      verify: async ({ token: presented }) => {
        if (presented !== token) throw new Error("invalid benchmark token");
        return {
          attribution: {
            actor: { principal: { kind: "person", personId: "person_zeyu" }, executor: { kind: "agent", id: "agent-w4-perf" } },
            principalSource: { kind: "daemon-authenticated", providerId: "w4-perf", credentialFingerprint: "sha256:redacted" },
            executorSource: "client-asserted"
          },
          claims: {
            tokenId: "token-w4-perf", issuer: "w4-perf", keyId: "key-w4-perf", workspaceId,
            deviceId: "device-w4-perf", viewId: "view-w4-perf", actorId: "person_zeyu", executorId: "agent-w4-perf",
            sessionId: "session-w4-perf", authorityGeneration: 1, channelNonceDigest, protocol,
            commandScopes: ["repo.document.write"], pathScopes: ["harness/**"], maxBytes: blobBytes * 2, maxOps: 1,
            issuedAt: "2026-07-14T00:00:00.000Z", notBefore: "2026-07-14T00:00:00.000Z",
            expiresAt: "2026-07-15T00:00:00.000Z", revocationEpoch: 1
          }
        };
      }
    },
    operationRegistry: createInMemoryAuthorityOperationRegistry(),
    replicaChangeLog: createInMemoryReplicaChangeLog(),
    publicationInspector: {
      currentHead: async () => gitOptional(rootDir, env, "rev-parse", "--verify", "HEAD"),
      inspectPublishedHead: async () => {
        const row = git(rootDir, env, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
        return { commitSha: row[0], parentCommits: row.slice(1) };
      }
    },
    fenceWitness: { assertHeld: async () => undefined },
    now: () => "2026-07-14T00:00:00.000Z"
  });
}

function v1Envelope(opId, operation) {
  const envelope = { workspaceId, opId, claimedDigest: "pending", command: "repo.document.write", operation, delegationToken: token, channelNonceDigest, protocol };
  return { ...envelope, claimedDigest: canonicalAuthorityRequestDigest(envelope) };
}

async function withGit(group, writers, body) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-w4-perf-"));
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "W4 Benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.test",
    GIT_COMMITTER_NAME: "Harness Authority", GIT_COMMITTER_EMAIL: "authority@example.test"
  };
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    execFileSync("git", ["-C", harnessRoot, "init", "-q"], { env });
    if (group === "hosted-small-op") {
      for (let round = 0; round < rounds; round += 1) {
        for (let writer = 0; writer < writers; writer += 1) {
          const ordinal = round * writers + writer;
          const taskId = `task_${stableId(writers * 100_000 + ordinal + 1)}`;
          const taskRoot = path.join(harnessRoot, "tasks", taskId);
          mkdirSync(taskRoot, { recursive: true });
          writeFileSync(path.join(taskRoot, "INDEX.md"), `# ${taskId}\n`, "utf8");
        }
      }
    }
    execFileSync("git", ["-C", harnessRoot, "add", "."], { env });
    execFileSync("git", ["-C", harnessRoot, "commit", "--allow-empty", "-m", "test: initialize W4 benchmark"], { env });
    return await body({ rootDir, env });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function sessionManifest(sessionId, body) {
  const sha = sha256Text(body);
  return {
    schema: "session-entity/v1", sessionId, lifecycle: "sealed", archiveStatus: "complete", runtime: "codex", source: "runtime",
    detectedAt: "2026-07-14T00:00:00.000Z", exportedAt: "2026-07-14T00:01:00.000Z",
    bodyRef: {
      store: "authored-cas/v1", ref: `harness/objects/sha256/${sha.slice(0, 2)}/${sha.slice(2)}`,
      sha256: sha, size: Buffer.byteLength(body), mediaType: "text/markdown; charset=utf-8"
    },
    snapshot: {
      capturedAt: "2026-07-14T00:01:00.000Z", completeness: "complete", captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "w4-perf", passed: true, findings: [] }
    }
  };
}

function executionRecord(taskId, executionId) {
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state: "active",
    primary_actor: { principal: { personId: "person_zeyu" }, executor: { kind: "agent", id: "agent-w4-perf" }, responsibleHuman: "person_zeyu" },
    claimed_at: "2026-07-14T00:00:00.000Z", submitted_at: null, closed_at: null,
    session_bindings: [], outputs: [], submission: null
  };
}

function reviewRecord(taskId, executionId, reviewId) {
  return {
    schema: "review/v2", review_id: reviewId, task_ref: `task/${taskId}`, execution_ref: `execution/${taskId}/${executionId}`,
    reviewer_actor: { principal: { personId: "person_reviewer" }, executor: { kind: "agent", id: "agent-reviewer" }, responsibleHuman: "person_reviewer" },
    reviewer_session_ref: "session/reviewer-w4", findings: "W4 performance review.", evidence_checked: [],
    rationale: "The hosted write is measured.", verdict: "approved", archive_warnings_acknowledged: true,
    reviewed_at: "2026-07-14T00:15:00.000Z"
  };
}

function fixedBody(size, suffix) {
  const prefix = `# ${suffix}\n`;
  return `${prefix}${"x".repeat(Math.max(0, size - Buffer.byteLength(prefix)))}`;
}

function stableId(value) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = BigInt(value);
  let result = "";
  do {
    result = alphabet[Number(remaining % 32n)] + result;
    remaining /= 32n;
  } while (remaining > 0n);
  return result.padStart(26, "0").slice(-26);
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50Ms: round(percentile(sorted, 0.5)), p95Ms: round(percentile(sorted, 0.95)), maxMs: round(sorted.at(-1) ?? 0), samplesMs: values.map(round) };
}

function percentile(sorted, quantile) { return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]; }
function round(value) { return Math.round(value * 100) / 100; }
function fixedHex(value, length) { return value.toString(16).padStart(length, "0").slice(-length); }
function integerOption(name, fallback) { const i = process.argv.indexOf(name); if (i < 0) return fallback; const value = Number(process.argv[i + 1]); if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} invalid`); return value; }
function integerListOption(name, fallback) { const i = process.argv.indexOf(name); if (i < 0) return fallback; const values = String(process.argv[i + 1]).split(",").map(Number); if (values.some((value) => !Number.isInteger(value) || value <= 0)) throw new Error(`${name} invalid`); return values; }
function enumListOption(name, allowed, fallback) { const i = process.argv.indexOf(name); if (i < 0) return fallback; const values = String(process.argv[i + 1]).split(","); if (values.some((value) => !allowed.includes(value))) throw new Error(`${name} invalid`); return [...new Set(values)]; }
function git(rootDir, env, ...args) { return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], { encoding: "utf8", env }).trim(); }
function gitOptional(rootDir, env, ...args) { try { return git(rootDir, env, ...args); } catch { return null; } }
function gitAt(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
