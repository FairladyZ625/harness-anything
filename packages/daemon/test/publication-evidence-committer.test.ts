// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  actorAxesBindingCoreDigestV2,
  canonicalAttributionEventDigestV2,
  makeLocalAuthorityAttributionEventV2Log,
  physicalChangeSetDigestV2,
  resolveHarnessLayout,
  semanticMutationSetDigestV2,
  type ActorAxesBindingCoreV2,
  type AttributionEventV2,
  type PhysicalChangeV2,
  type SemanticMutationSetV2
} from "@harness-anything/kernel";
import { createGitAuthorityAttributionEvidenceCommitterV2 } from "../src/authority/production/publication-evidence.ts";
import { runWithRepoWriteTelemetry } from "../src/runtime/repo-write-telemetry-context.ts";

const digestA = "11".repeat(32);
const digestB = "22".repeat(32);

test("evidence commit rejects corruption in a shard anchored by the verified HEAD", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-committer-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");

  const log = makeLocalAuthorityAttributionEventV2Log(root);
  const committer = createGitAuthorityAttributionEvidenceCommitterV2(root);
  log.ensure(v2Event("op-history"));
  await committer.commitPending(git(root, "rev-parse", "HEAD"));

  log.ensure(v2Event("op-next"));
  await committer.commitPending(git(root, "rev-parse", "HEAD"));

  const layout = resolveHarnessLayout(root);
  const historicalPath = path.join(
    layout.authorityAttributionEventsV2Root,
    readdirSync(layout.authorityAttributionEventsV2Root).sort()[0]!
  );
  writeFileSync(historicalPath, "{}\n");
  log.ensure(v2Event("op-pending"));

  await assert.rejects(
    committer.commitPending(git(root, "rev-parse", "HEAD")),
    /AUTHORITY_EVENT_V2_EVIDENCE_VERIFIED_HISTORY_CHANGED/u
  );
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
});

test("canonical HEAD advancement outside the evidence tree preserves the verified baseline", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-baseline-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");

  const log = makeLocalAuthorityAttributionEventV2Log(root);
  const committer = createGitAuthorityAttributionEvidenceCommitterV2(root);
  log.ensure(v2Event("op-history"));
  await committer.commitPending(git(root, "rev-parse", "HEAD"));

  writeFileSync(path.join(root, "seed.txt"), "canonical advancement\n");
  git(root, "add", "seed.txt");
  git(root, "commit", "-q", "-m", "canonical advancement outside evidence");
  log.ensure(v2Event("op-pending"));
  const phases: string[] = [];
  await runWithRepoWriteTelemetry(
    (phase) => phases.push(phase),
    () => committer.commitPending(git(root, "rev-parse", "HEAD"))
  );

  assert.ok(phases.includes("authority-evidence-pending-verify"), phases.join(","));
  assert.ok(phases.includes("authority-evidence-git-commit-done"), phases.join(","));
  assert.equal(phases.includes("authority-evidence-history-verify"), false, phases.join(","));
});

test("canonical HEAD advancement that changes evidence history forces full verification", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-history-change-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");

  const log = makeLocalAuthorityAttributionEventV2Log(root);
  const committer = createGitAuthorityAttributionEvidenceCommitterV2(root);
  log.ensure(v2Event("op-history"));
  await committer.commitPending(git(root, "rev-parse", "HEAD"));
  const layout = resolveHarnessLayout(root);
  const historicalPath = path.join(
    layout.authorityAttributionEventsV2Root,
    readdirSync(layout.authorityAttributionEventsV2Root)[0]!
  );
  writeFileSync(historicalPath, "{}\n");
  git(root, "add", historicalPath);
  git(root, "commit", "-q", "-m", "corrupt committed evidence history");
  const phases: string[] = [];

  await assert.rejects(runWithRepoWriteTelemetry(
    (phase) => phases.push(phase),
    () => committer.commitPending(git(root, "rev-parse", "HEAD"))
  ));
  assert.ok(phases.includes("authority-evidence-history-verify"), phases.join(","));
});

test("one evidence batch commits two shards with a bounded Git spawn count and a clean shared index", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-evidence-batch-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "seed");
  const canonicalCommitSha = git(root, "rev-parse", "HEAD");
  const log = makeLocalAuthorityAttributionEventV2Log(root);
  log.ensure(v2Event("op-batch-a"));
  log.ensure(v2Event("op-batch-b"));
  const tracePath = path.join(root, "git-trace.jsonl");
  const priorTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  const startedAt = performance.now();
  try {
    await createGitAuthorityAttributionEvidenceCommitterV2(root).commitPending(canonicalCommitSha);
  } finally {
    if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = priorTrace;
  }

  const spawnCount = readFileSync(tracePath, "utf8").split("\n").filter((line) => {
    if (!line) return false;
    return (JSON.parse(line) as { readonly event?: string }).event === "start";
  }).length;
  context.diagnostic(JSON.stringify({
    schema: "authority-evidence-batch-measurement/v1",
    operationCount: 2,
    gitSpawnCount: spawnCount,
    wallMs: performance.now() - startedAt
  }));
  assert.equal(git(root, "rev-list", "--count", `${canonicalCommitSha}..HEAD`), "1");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  assert.equal(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").length, 2);
  assert.equal(spawnCount <= 14, true, `evidence commit spawned ${spawnCount} Git processes`);
});

function v2Event(opId: string): AttributionEventV2 {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [{
      entity: {
        registryVersion: 1,
        entityKind: "fact",
        canonicalRef: "fact/task_T/F-1"
      },
      action: { registryVersion: 1, action: "create" }
    }]
  };
  const actorAxesBinding: ActorAxesBindingCoreV2 = {
    bindingId: "binding-1",
    principalPersonId: "person_zeyu",
    executorAgentId: "agent-codex",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    schemaTuple: {
      wire: 2,
      event: 2,
      receipt: 2,
      digest: 2,
      policy: 1,
      commandRegistry: 1,
      entityRegistry: 1,
      mutationRegistry: 1,
      localState: 1,
      applyJournal: 1
    }
  };
  const physicalChanges: ReadonlyArray<PhysicalChangeV2> = [{
    path: "tasks/task_T/facts.md",
    beforeDigest: digestA,
    afterDigest: digestB
  }];
  const withoutEventDigest: Omit<AttributionEventV2, "canonicalEventDigest"> = {
    schema: "attribution-event/v2",
    eventId: `attribution:${opId}`,
    workspaceId: "workspace-1",
    opId,
    revision: 1,
    commitSha: "commit-v2",
    previousCommit: "commit-v1",
    outcome: "COMMITTED",
    occurredAt: "2026-07-16T12:00:00.000Z",
    recordedAt: "2026-07-16T12:00:00.100Z",
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

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function git(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
