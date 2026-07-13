import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  authorityProtocolTuple,
  canonicalAuthorityRequestDigest,
  createAuthoritySubmissionService,
  createInMemoryAuthorityOperationRegistry,
  createInMemoryReplicaChangeLog
} from "../../packages/application/src/index.ts";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  entityRegistry,
  makeJournaledWriteCoordinator,
  taskEntityId
} from "../../packages/kernel/src/index.ts";

const writerCounts = positiveIntegerListOption("--writers", [2, 4, 8]);
const rounds = positiveIntegerOption("--rounds", 10);
const workspaceId = "workspace-authority-perf";
const channelNonceDigest = "sha256:authority-perf-channel";
const token = "authority-perf-token";

const scenarios = [];
for (const writers of writerCounts) {
  scenarios.push(await runScenario(writers));
}

process.stdout.write(`${JSON.stringify({
  schema: "authority-concurrency-benchmark/v1",
  measuredAt: new Date().toISOString(),
  sourceCommit: gitAt(process.cwd(), "rev-parse", "HEAD"),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  metric: "submit-to-durable-receipt-ms",
  rounds,
  scenarios
}, null, 2)}\n`);

async function runScenario(writers) {
  return withHermeticGit(async ({ rootDir, env }) => {
    const service = makeAuthority(rootDir, env);
    const registry = benchmarkRegistry();
    const samplesMs = [];
    const registryCompileSamplesMs = [];
    const authoritySubmitSamplesMs = [];
    for (let round = 0; round < rounds; round += 1) {
      const envelopes = Array.from(
        { length: writers },
        (_, writer) => operationEnvelope(writers, round, writer)
      );
      const samples = await Promise.all(envelopes.map(async (envelope) => {
        const startedAt = performance.now();
        const compileStartedAt = performance.now();
        compileRegistryMutationPlan(registry, benchmarkMutationInput(envelope.operation.entityId));
        const registryCompileMs = performance.now() - compileStartedAt;
        const submitStartedAt = performance.now();
        const receipt = await service.submit(envelope);
        const authoritySubmitMs = performance.now() - submitStartedAt;
        const elapsedMs = performance.now() - startedAt;
        if (receipt.tag !== "COMMITTED") {
          throw new Error(`benchmark operation ${envelope.opId} returned ${receipt.tag}`);
        }
        return { elapsedMs, registryCompileMs, authoritySubmitMs };
      }));
      samplesMs.push(...samples.map((sample) => sample.elapsedMs));
      registryCompileSamplesMs.push(...samples.map((sample) => sample.registryCompileMs));
      authoritySubmitSamplesMs.push(...samples.map((sample) => sample.authoritySubmitMs));
    }
    const summary = sampleSummary(samplesMs);
    return {
      writers,
      attempts: samplesMs.length,
      ...summary,
      segments: {
        registryCompileMs: sampleSummary(registryCompileSamplesMs),
        authoritySubmitMs: sampleSummary(authoritySubmitSamplesMs)
      }
    };
  });
}

function benchmarkRegistry() {
  const writable = (kind) => ({
    ...entityRegistry[kind],
    mutationContract: { status: "ready", actions: ["benchmark-only"] },
    semanticDiff: { status: "ready", compile: () => [] },
    projectionFacet: { status: "ready", project: () => undefined, resolveCanonicalRef: () => ({}) }
  });
  return createWritableEntityRegistry([writable("fact"), writable("relation")]);
}

function benchmarkMutationInput(entityId) {
  const taskId = entityId.slice("task/".length);
  return {
    registryVersion: 1,
    mutations: [
      { entityKind: "fact", identity: { taskId, factId: "F-benchmark" }, action: "benchmark-only" },
      {
        entityKind: "relation",
        identity: { relationId: "rel_0123456789abcdef" },
        action: "benchmark-only",
        storageContext: { sourceRef: `fact/${taskId}/F-benchmark` }
      }
    ]
  };
}

function makeAuthority(rootDir, env) {
  return createAuthoritySubmissionService({
    workspaceId,
    coordinatorFactory: {
      create: ({ attribution }) => makeJournaledWriteCoordinator({
        rootDir,
        attribution,
        commitAuthor: { name: "Authenticated Person", email: "person@example.test" },
        autoMaterialize: false
      })
    },
    tokenVerifier: {
      verify: async ({ token: presentedToken }) => {
        if (presentedToken !== token) throw new Error("invalid benchmark token");
        return {
          attribution: {
            actor: {
              principal: { kind: "person", personId: "person_zeyu" },
              executor: { kind: "agent", id: "agent-authority-perf" }
            },
            principalSource: {
              kind: "daemon-authenticated",
              providerId: "authority-perf",
              credentialFingerprint: "sha256:redacted"
            },
            executorSource: "client-asserted"
          },
          claims: {
            tokenId: "token-authority-perf",
            issuer: "authority-perf",
            keyId: "key-authority-perf",
            workspaceId,
            deviceId: "device-authority-perf",
            viewId: "view-authority-perf",
            actorId: "person_zeyu",
            executorId: "agent-authority-perf",
            sessionId: "session-authority-perf",
            authorityGeneration: 1,
            channelNonceDigest,
            protocol: authorityProtocolTuple,
            commandScopes: ["repo.document.write"],
            pathScopes: ["harness/tasks/**"],
            maxBytes: 64 * 1024,
            maxOps: 1,
            issuedAt: "2026-07-13T00:00:00.000Z",
            notBefore: "2026-07-13T00:00:00.000Z",
            expiresAt: "2026-07-14T00:00:00.000Z",
            revocationEpoch: 1
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

function operationEnvelope(writers, round, writer) {
  const suffix = `n${writers}-r${round}-w${writer}`;
  const opId = `authority-perf-${suffix}`;
  const envelope = {
    workspaceId,
    opId,
    claimedDigest: "pending",
    command: "repo.document.write",
    operation: {
      opId,
      entityId: taskEntityId(`task-authority-perf-${suffix}`),
      kind: "doc_write",
      payload: { path: "notes.md", body: `${suffix}\n` }
    },
    delegationToken: token,
    channelNonceDigest,
    protocol: authorityProtocolTuple
  };
  return { ...envelope, claimedDigest: canonicalAuthorityRequestDigest(envelope) };
}

async function withHermeticGit(body) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authority-perf-"));
  const home = path.join(rootDir, "empty-home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Harness Benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@example.test",
    GIT_COMMITTER_NAME: "Harness Benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@example.test"
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"], { env });
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    execFileSync("git", ["-C", path.join(rootDir, "harness"), "init", "-q"], { env });
    git(rootDir, env, "commit", "--allow-empty", "-m", "test: initialize authority benchmark");
    return await body({ rootDir, env });
  } finally {
    restoreEnvironment(previous);
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function git(rootDir, env, ...args) {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    env
  }).trim();
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

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return rounded(sorted[Math.ceil(sorted.length * quantile) - 1]);
}

function sampleSummary(samplesMs) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: rounded(sorted.at(-1) ?? 0),
    samplesMs: samplesMs.map(rounded)
  };
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function positiveIntegerOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveIntegerListOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const values = String(process.argv[index + 1] ?? "")
    .split(",")
    .map(Number);
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  }
  return [...new Set(values)];
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
