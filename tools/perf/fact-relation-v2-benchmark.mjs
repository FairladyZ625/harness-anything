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
  encodeFactRelationCommandPayloadV2,
  makeFactRelationSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2
} from "../../packages/application/src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  deriveRelationId,
  entityRegistry,
  formatFactFlowRecord,
  makeJournaledWriteCoordinator
} from "../../packages/kernel/src/index.ts";

const writerCounts = positiveIntegerListOption("--writers", [2, 4, 8]);
const rounds = positiveIntegerOption("--rounds", 10);
const scopes = enumListOption("--scopes", ["same-scope", "disjoint"], ["same-scope", "disjoint"]);
const workspaceId = "workspace-w2-perf";
const channelNonceDigest = "sha256:w2-perf-channel";
const token = "w2-perf-token";
const baseDigest = Buffer.alloc(32, 0x11);
const authorityProtocol = { wire: 1, event: 1, receipt: 1, digest: 1, commandRegistry: 1 };
const scenarios = [];

for (const scope of scopes) {
  for (const writers of writerCounts) scenarios.push(await runScenario(scope, writers));
}

process.stdout.write(`${JSON.stringify({
  schema: "fact-relation-v2-concurrency-benchmark/v1",
  measuredAt: new Date().toISOString(),
  sourceCommit: gitAt(process.cwd(), "rev-parse", "HEAD"),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  workload: "fact.invalidate + relation.create; hosted facts.md",
  rounds,
  scenarios
}, null, 2)}\n`);

async function runScenario(scope, writers) {
  return withHermeticGit(scope, writers, async ({ rootDir, env }) => {
    const queueWaitByOp = new Map();
    const submitStartedByOp = new Map();
    const service = makeAuthority(rootDir, env, queueWaitByOp, submitStartedByOp);
    const compiler = makeFactRelationSemanticCompilerV2({
      state: {
        readEntityBase: async (entityRef) => entityRef.entityKind === "fact"
          ? { semanticVersion: "fact-v1", stateDigest: baseDigest }
          : null,
        readHostedDocument: async () => null
      }
    });
    const registry = createWritableEntityRegistry([entityRegistry.fact, entityRegistry.relation]);
    const endToEndMs = [];
    const compilerMs = [];
    const queueWaitMs = [];
    const commitIndexMs = [];
    for (let round = 0; round < rounds; round += 1) {
      const samples = await Promise.all(Array.from({ length: writers }, async (_, writer) => {
        const fixture = operationFixture(scope, writers, round, writer);
        const startedAt = performance.now();
        const compileStartedAt = performance.now();
        const semantic = await compiler.compile(fixture.envelope);
        const compiled = compileRegistryMutationPlan(registry, semantic.mutationPlan);
        const compileElapsed = performance.now() - compileStartedAt;
        if (compiled.mutationSet.mutations.length !== 2 || compiled.storagePlan.targets.length !== 1) {
          throw new Error("W2 benchmark compiler did not produce one hosted two-mutation plan");
        }
        submitStartedByOp.set(fixture.opId, performance.now());
        const receipt = await service.submit(v1Envelope(fixture.opId, { ...semantic.operation, opId: fixture.opId }));
        const elapsed = performance.now() - startedAt;
        if (receipt.tag !== "COMMITTED") throw new Error(`benchmark operation ${fixture.opId} returned ${receipt.tag}`);
        const queueElapsed = queueWaitByOp.get(fixture.opId);
        if (queueElapsed === undefined) throw new Error(`queue wait missing for ${fixture.opId}`);
        return {
          endToEndMs: elapsed,
          compilerMs: compileElapsed,
          queueWaitMs: queueElapsed,
          commitIndexMs: Math.max(0, elapsed - compileElapsed - queueElapsed)
        };
      }));
      endToEndMs.push(...samples.map((sample) => sample.endToEndMs));
      compilerMs.push(...samples.map((sample) => sample.compilerMs));
      queueWaitMs.push(...samples.map((sample) => sample.queueWaitMs));
      commitIndexMs.push(...samples.map((sample) => sample.commitIndexMs));
    }
    return {
      scope,
      writers,
      attempts: endToEndMs.length,
      endToEndMs: sampleSummary(endToEndMs),
      segments: {
        registryCompileSemanticDiffMs: sampleSummary(compilerMs),
        coordinatorQueueWaitMs: sampleSummary(queueWaitMs),
        commitIndexMs: sampleSummary(commitIndexMs)
      }
    };
  });
}

function operationFixture(scope, writers, round, writer) {
  const suffix = `${scope === "same-scope" ? "same" : "disjoint"}-n${writers}-r${round}-w${writer}`;
  const taskId = scope === "same-scope"
    ? `task-w2-same-n${writers}`
    : `task-w2-disjoint-n${writers}-w${writer}`;
  const ordinal = round * writers + writer;
  const oldFactId = factId(ordinal * 2 + 1);
  const newFactId = factId(ordinal * 2 + 2);
  const relationId = deriveRelationId({
    source: `fact/${taskId}/${newFactId}`,
    target: `fact/${taskId}/${oldFactId}`,
    type: "supersedes-fact",
    direction: "directed"
  });
  const baseCas = [
    present("fact", `fact/${taskId}/${oldFactId}`),
    present("fact", `fact/${taskId}/${newFactId}`),
    absent("relation", `relation/${relationId}`)
  ];
  const payload = encodeFactRelationCommandPayloadV2({
    schema: "fact.invalidate/v1",
    ownerTaskId: taskId,
    factId: oldFactId,
    invalidatedByFactId: newFactId,
    rationale: `W2 performance control ${suffix}`
  });
  const mutationSet = { registryVersion: 1, mutations: [] };
  const draft = {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId,
    operationId: {
      namespace: {
        schema: "operation-namespace/v1", workspaceId, deviceId: "device-w2-perf",
        authorityGeneration: 1n, namespaceId: "namespace-w2-perf", expiresAt: 9_000n,
        issuer: "authority.perf", keyId: "namespace-key", proof: Buffer.alloc(32, 3)
      },
      clientRandom128: Buffer.from(fixedHex(ordinal + (scope === "same-scope" ? 1 : 1_000_000), 32), "hex")
    },
    binding: {
      bindingId: "binding-w2-perf", actorAxesBindingDigest: Buffer.alloc(32, 4),
      deviceId: "device-w2-perf", viewId: "view-w2-perf", sessionId: "session-w2-perf",
      admissionTokenRef: { tokenId: "token-w2-perf", tokenDigest: Buffer.alloc(32, 5) }
    },
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
      commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
    },
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "fact.invalidate", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(payload.length), bytes: payload },
      canonicalPayloadDigest: canonicalPayloadDigestV2(payload),
      baseCas,
      declaredPathCas: []
    },
    claimedMutationSet: mutationSet,
    claimedSemanticMutationSetDigest: semanticMutationSetDigestV2(mutationSet),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
  return {
    opId: `w2-perf-${suffix}`,
    envelope: { ...draft, claimedSemanticRequestDigest: semanticRequestDigestV2(draft) }
  };
}

function makeAuthority(rootDir, env, queueWaitByOp, submitStartedByOp) {
  return createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => {
        const coordinator = makeJournaledWriteCoordinator({
          rootDir,
          attribution,
          commitAuthor: { name: "W2 Benchmark", email: "benchmark@example.test" },
          autoMaterialize: false
        });
        return {
          enqueue: (operation) => Effect.gen(function* () {
            const submitStartedAt = submitStartedByOp.get(operation.opId);
            if (submitStartedAt === undefined) throw new Error(`submit start missing for ${operation.opId}`);
            queueWaitByOp.set(operation.opId, performance.now() - submitStartedAt);
            return yield* coordinator.enqueue(operation);
          }),
          flush: coordinator.flush,
          recover: coordinator.recover
        };
      }
    },
    tokenVerifier: {
      verify: async ({ token: presentedToken }) => {
        if (presentedToken !== token) throw new Error("invalid benchmark token");
        return {
          attribution: {
            actor: {
              principal: { kind: "person", personId: "person_zeyu" },
              executor: { kind: "agent", id: "agent-w2-perf" }
            },
            principalSource: { kind: "daemon-authenticated", providerId: "w2-perf", credentialFingerprint: "sha256:redacted" },
            executorSource: "client-asserted"
          },
          claims: {
            tokenId: "token-w2-perf", issuer: "w2-perf", keyId: "key-w2-perf", workspaceId,
            deviceId: "device-w2-perf", viewId: "view-w2-perf", actorId: "person_zeyu",
            executorId: "agent-w2-perf", sessionId: "session-w2-perf", authorityGeneration: 1,
            channelNonceDigest, protocol: authorityProtocol,
            commandScopes: ["repo.document.write"], pathScopes: ["harness/tasks/**"],
            maxBytes: 64 * 1024, maxOps: 1,
            issuedAt: "2026-07-13T00:00:00.000Z", notBefore: "2026-07-13T00:00:00.000Z",
            expiresAt: "2026-07-14T00:00:00.000Z", revocationEpoch: 1
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
    now: () => "2026-07-13T00:00:00.000Z"
  });
}

function v1Envelope(opId, operation) {
  const envelope = {
    workspaceId,
    opId,
    claimedDigest: "pending",
    command: "repo.document.write",
    operation,
    delegationToken: token,
    channelNonceDigest,
    protocol: authorityProtocol
  };
  return { ...envelope, claimedDigest: canonicalAuthorityRequestDigest(envelope) };
}

async function withHermeticGit(scope, writers, body) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-w2-perf-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "W2 Benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.test",
    GIT_COMMITTER_NAME: "Harness Authority", GIT_COMMITTER_EMAIL: "authority@example.test"
  };
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    execFileSync("git", ["-C", harnessRoot, "init", "-q"], { env });
    prepopulateFacts(harnessRoot, scope, writers);
    execFileSync("git", ["-C", harnessRoot, "add", "."], { env });
    execFileSync("git", ["-C", harnessRoot, "commit", "-m", "test: initialize W2 benchmark"], { env });
    return await body({ rootDir, env });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function prepopulateFacts(harnessRoot, scope, writers) {
  const byTask = new Map();
  for (let round = 0; round < rounds; round += 1) {
    for (let writer = 0; writer < writers; writer += 1) {
      const fixture = operationFixture(scope, writers, round, writer);
      const payload = JSON.parse(Buffer.from(fixture.envelope.intent.canonicalPayload.bytes).toString("utf8"));
      const records = byTask.get(payload.ownerTaskId) ?? [];
      records.push(factRecord(payload.factId), factRecord(payload.invalidatedByFactId));
      byTask.set(payload.ownerTaskId, records);
    }
  }
  for (const [taskId, records] of byTask) {
    const taskRoot = path.join(harnessRoot, "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId), "utf8");
    writeFileSync(path.join(taskRoot, "facts.md"), `# Facts\n\n${records.map(formatFactFlowRecord).join("\n")}\n`, "utf8");
  }
}

function taskIndex(taskId) {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: W2 benchmark ${taskId}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    `  titleSnapshot: W2 benchmark ${taskId}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
    "  bindingFingerprint: sha256:w2-benchmark",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# W2 benchmark ${taskId}`,
    ""
  ].join("\n");
}

function factRecord(factIdValue) {
  return {
    fact_id: factIdValue,
    statement: `benchmark fact ${factIdValue}`,
    source: "W2 benchmark fixture",
    observedAt: "2026-07-13T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{ runtime: "codex", sessionId: "session-w2-perf", boundAt: "2026-07-13T00:00:00.000Z" }]
  };
}

function factId(value) {
  return `F-${fixedHex(value, 8)}`;
}

function fixedHex(value, length) {
  return value.toString(16).toUpperCase().padStart(length, "0").slice(-length);
}

function present(entityKind, canonicalRef) {
  return {
    entityRef: { registryVersion: 1, entityKind, canonicalRef },
    expectedSemanticVersion: "fact-v1",
    expectedStateDigest: baseDigest
  };
}

function absent(entityKind, canonicalRef) {
  return {
    entityRef: { registryVersion: 1, entityKind, canonicalRef },
    expectedSemanticVersion: null,
    expectedStateDigest: null
  };
}

function sampleSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(sorted.at(-1) ?? 0),
    samplesMs: values.map(rounded)
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function positiveIntegerOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveIntegerListOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const values = String(process.argv[index + 1] ?? "").split(",").map(Number);
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a comma-separated positive integer list`);
  }
  return values;
}

function enumListOption(name, allowed, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const values = String(process.argv[index + 1] ?? "").split(",");
  if (values.length === 0 || values.some((value) => !allowed.includes(value))) {
    throw new Error(`${name} must be a comma-separated subset of ${allowed.join(",")}`);
  }
  return [...new Set(values)];
}

function git(rootDir, env, ...args) {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], { encoding: "utf8", env }).trim();
}

function gitOptional(rootDir, env, ...args) {
  try {
    return git(rootDir, env, ...args);
  } catch {
    return null;
  }
}

function gitAt(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
