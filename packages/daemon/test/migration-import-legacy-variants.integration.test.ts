// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  canonicalizeContractValue,
  compileFactWrite,
  compileScheduleDefinitionEvent,
  createScheduleV1,
  eventObjectRelativePath,
  makeTaskProjection,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Text,
  type PersistedCanonicalEventV1,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { actor, git, initRepo, legacyFixture } from "./migration-import.fixtures.ts";

type VariantBuilder = (root: string) => void;

const variants: readonly { readonly name: string; readonly build: VariantBuilder; readonly observation?: RegExp }[] = [
  { name: "markdown-only-v0", build: legacyFixture },
  { name: "flat-task-v1-events", build: (root) => taskV1Fixture(root, "flat/v1") },
  { name: "sharded-task-v1-events", build: (root) => taskV1Fixture(root, "sharded-sha256-2/v1") },
  { name: "migration-import-task-v1", build: migrationTaskV1Fixture },
  {
    name: "in-place-migration-import-task-v1",
    build: inPlaceMigrationTaskV1Fixture,
    observation: /ACCEPT legacy_event_normalized .*provenance=imported_snapshot/u,
  },
  { name: "legacy-doc-commit-cut", build: legacyDocCutFixture },
  { name: "task-local-fact-event", build: legacyFactEventFixture },
  { name: "taskless-fact-current-provenance", build: tasklessFactFixture },
  {
    name: "schedule-definition-facet-drift",
    build: scheduleFacetDriftFixture,
    observation: /ACCEPT schedule_definition_facet_mismatch/u,
  },
];

test("every historical canonical format fixture dry-runs through one-command oracle rebuild", async (t) => {
  for (const variant of variants)
    await t.test(variant.name, async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), `ha-migration-variant-${variant.name}-`)),
        source = path.join(scratch, "source"),
        destination = path.join(scratch, "destination");
      let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
      try {
        variant.build(source);
        commitSource(source);
        initRepo(destination);
        cell = await openRepoCell({
          repoId: workspaceId(`migration-${variant.name}`),
          rootDir: canonicalRoot(destination),
          ownerId: "migration-daemon",
          now: () => "2026-08-31T00:00:00.000Z",
        });
        const result = (await cell.run(
          { kind: "migrate-import", sourceRoots: [source], dryRun: true },
          { actor, source: "local" },
        )) as Record<string, unknown>;
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        assert.match(String(result.summary), /Oracle: rebuilt-source/u);
        assert.match(String(result.summary), /Reconciliation: PASS/u);
        assert.doesNotMatch(String(result.summary), /invalid_write_plan/u);
        if (variant.observation) assert.match(String(result.summary), variant.observation);
      } finally {
        await cell?.close();
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    });
});

function taskV1Fixture(root: string, layout: "flat/v1" | "sharded-sha256-2/v1"): void {
  const taskId = `task_${layout === "flat/v1" ? "flat" : "sharded"}`,
    body = taskDocument(taskId, `Legacy ${layout}`),
    event = taskV1Event(taskId, 1),
    eventBody = serializePersistedCanonicalEvent(event as unknown as PersistedCanonicalEventV1);
  baseFixture(root, taskId, body);
  writeEvent(root, event.opId, eventBody, layout);
  writeHead(root, 1, event.opId, eventBody);
}

function migrationTaskV1Fixture(root: string): void {
  const taskId = "task_imported_v1",
    body = taskDocument(taskId, "Imported Task/v1"),
    claim = migrationClaim(`tasks/${taskId}-imported-task-v1/INDEX.md`, body, "text/markdown"),
    event = {
      schema: "migration-import-event/v1",
      eventId: "event-imported-v1",
      workspaceRevision: 1,
      opId: "op-imported-v1",
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-08-15T00:00:00.000Z",
      payload: {
        migratedFrom: taskId,
        generation: "v0",
        entity: {
          kind: "task",
          task: legacyTask(taskId, "Imported Task/v1"),
          originalStatus: "planned",
          packagePath: `tasks/${taskId}-imported-task-v1`,
          documentClaim: claim,
        },
      },
    },
    eventBody = `${JSON.stringify(canonicalizeContractValue(event))}\n`;
  baseFixture(root, taskId, body, `tasks/${taskId}-imported-task-v1`);
  writeBlob(root, claim.sha256, body);
  writeEvent(root, event.opId, eventBody, "flat/v1");
  writeHead(root, 1, event.opId, eventBody);
}

function inPlaceMigrationTaskV1Fixture(root: string): void {
  migrationTaskV1Fixture(root);
  writeFileSync(path.join(root, ".gitignore"), "/.harness/\n");
  const projection = makeTaskProjection({
    rootDir: root,
    eventStore: {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
  });
  projection.rebuild();
  projection.close();
}

function legacyFactEventFixture(root: string): void {
  const taskId = "task_fact_local",
    factId = "F-ABCDEF12",
    taskRoot = baseFixture(root, taskId, taskDocument(taskId, "Task-local fact")),
    factsBody = `# Facts\n\n- {fact_id: ${factId}, statement: Legacy event fact, source: fixture, observedAt: 2026-08-15T00:00:00.000Z, confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: codex, sessionId: legacy-session, boundAt: 2026-08-15T00:00:00.000Z}]}\n`,
    claim = {
      path: `${path.relative(path.join(root, "harness"), taskRoot).split(path.sep).join("/")}/facts.md`,
      sha256: sha256Text(factsBody),
      size: Buffer.byteLength(factsBody),
      mediaType: "text/markdown",
      policyId: "typed-machine-writer/v1",
    },
    event = {
      schema: "fact-event/v1",
      eventId: "event-legacy-fact",
      workspaceRevision: 1,
      opId: "op-legacy-fact",
      taskId,
      factId,
      type: "fact_recorded",
      actor,
      source: "local",
      occurredAt: "2026-08-15T00:00:00.000Z",
      payload: {
        statement: "Legacy event fact",
        evidenceSource: "fixture",
        observedAt: "2026-08-15T00:00:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: ["pattern"],
        provenance: [{ runtime: "codex", sessionId: "legacy-session", boundAt: "2026-08-15T00:00:00.000Z" }],
        factsDocumentClaim: claim,
      },
    },
    eventBody = `${JSON.stringify(event)}\n`;
  writeFileSync(path.join(taskRoot, "facts.md"), factsBody);
  writeBlob(root, claim.sha256, factsBody);
  writeEvent(root, event.opId, eventBody, "flat/v1");
  writeHead(root, 1, event.opId, eventBody);
}

function legacyDocCutFixture(root: string): void {
  const taskId = "task_doc_cut",
    body = "historical opaque note\n",
    sha256 = sha256Text(body),
    event = {
      schema: "doc-event/v1",
      eventId: "event-doc-commit-cut",
      workspaceRevision: 1,
      opId: "op-doc-commit-cut",
      type: "documents_written",
      actor,
      source: "local",
      occurredAt: "2026-08-20T00:00:00.000Z",
      payload: {
        executionId: null,
        baseLedgerSha: { repoId: "legacy-repo", sha: "a".repeat(40) },
        changes: [
          {
            path: `tasks/${taskId}-doc-cut/artifacts/note.txt`,
            baseBlobSha256: null,
            candidate: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain" },
            policyId: "opaque-textual-whole-file/v1",
            regionProofs: [],
          },
        ],
      },
    },
    eventBody = `${JSON.stringify(canonicalizeContractValue(event))}\n`;
  baseFixture(root, taskId, taskDocument(taskId, "Legacy document cut"), `tasks/${taskId}-doc-cut`);
  writeBlob(root, sha256, body);
  writeEvent(root, event.opId, eventBody, "flat/v1");
  writeHead(root, 1, event.opId, eventBody);
}

function tasklessFactFixture(root: string): void {
  const factId = "F-FACEB00C",
    compiled = compileFactWrite({
      event: {
        schema: "fact-event/v1",
        eventId: "event-taskless-current",
        workspaceRevision: 1,
        opId: "op-taskless-current",
        factId,
        type: "fact_recorded",
        actor,
        source: "local",
        occurredAt: "2026-08-27T00:00:00.000Z",
        payload: {
          statement: "Taskless historical fact",
          evidenceSource: "fixture",
          observedAt: "2026-08-27T00:00:00.000Z",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
          provenance: [
            {
              runtime: "codex",
              sessionId: null,
              transcriptReachability: "unavailable",
              boundAt: "2026-08-27T00:00:00.000Z",
            },
          ],
        },
      },
    }),
    eventBody = serializePersistedCanonicalEvent(compiled.event);
  harnessRoot(root);
  mkdirSync(path.join(root, "harness/facts"), { recursive: true });
  writeFileSync(path.join(root, `harness/facts/${factId}.md`), compiled.body);
  writeBlob(root, compiled.blobs[0].sha256, compiled.blobs[0].body);
  writeEvent(root, compiled.event.opId, eventBody, "sharded-sha256-2/v1");
  writeHead(root, 1, compiled.event.opId, eventBody);
}

function scheduleFacetDriftFixture(root: string): void {
  baseFixture(root, "task_schedule_witness", taskDocument("task_schedule_witness", "Schedule witness"));
  const schedule = createScheduleV1({
      scheduleId: "schedule-fixture",
      name: "Historical schedule",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-08-26T00:00:00.000Z" },
        target: { kind: "agent", agentId: "agent-fixture", runtimeInstanceId: "runtime-fixture" },
        mission: "Preserve the historical schedule.",
      },
      actor,
      occurredAt: "2026-08-26T00:00:00.000Z",
    }),
    compiled = compileScheduleDefinitionEvent({
      type: "schedule_created",
      schedule,
      eventId: "event-schedule-drift",
      opId: "op-schedule-drift",
      workspaceRevision: 1,
      actor,
      source: "local",
      occurredAt: "2026-08-26T00:00:00.000Z",
    }),
    historicalBody = `${JSON.stringify(schedule, null, 2)}\n`,
    historicalClaim = {
      ...compiled.event.payload.declarationDocumentClaim,
      sha256: sha256Text(historicalBody),
      size: Buffer.byteLength(historicalBody),
    },
    event = {
      ...compiled.event,
      payload: { ...compiled.event.payload, declarationDocumentClaim: historicalClaim },
    },
    eventBody = serializePersistedCanonicalEvent(event);
  writeBlob(root, historicalClaim.sha256, historicalBody);
  writeEvent(root, event.opId, eventBody, "sharded-sha256-2/v1");
  writeHead(root, 1, event.opId, eventBody);
}

function baseFixture(root: string, taskId: string, body: string, packagePath?: string): string {
  harnessRoot(root);
  const taskRoot = path.join(root, "harness", packagePath ?? `tasks/${taskId}-${slug(taskId)}`);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), body);
  return taskRoot;
}

function harnessRoot(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
}

function taskDocument(taskId: string, title: string): string {
  return `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: ${JSON.stringify(title)}\nlifecycle:\n  status: planned\n  engine: local\n  bindingCreatedAt: 2026-08-15T00:00:00.000Z\nvertical: software/coding\npreset: standard-task\nprofile: baseline\n---\n\n# ${title}\n`;
}

function taskV1Event(taskId: string, workspaceRevision: number) {
  return {
    schema: "task-event/v1",
    eventId: `event-${taskId}`,
    workspaceRevision,
    opId: `op-${taskId}`,
    taskId,
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-08-15T00:00:00.000Z",
    payload: { task: legacyTask(taskId, `Legacy ${taskId}`) },
  };
}

function legacyTask(taskId: string, title: string) {
  return {
    schema: "task/v1",
    taskId,
    title,
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
  };
}

function migrationClaim(target: string, body: string, mediaType: string) {
  return {
    path: target,
    sha256: sha256Text(body),
    size: Buffer.byteLength(body),
    mediaType,
    policyId: "typed-migration-import/v1",
  };
}

function writeEvent(root: string, opId: string, body: string, layout: "flat/v1" | "sharded-sha256-2/v1"): void {
  const target = path.join(root, "harness", eventObjectRelativePath(opId, layout));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function writeBlob(root: string, sha256: string, body: string): void {
  const target = path.join(root, "harness/objects/sha256", sha256.slice(0, 2), sha256.slice(2));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function writeHead(root: string, revision: number, opId: string, eventBody: string): void {
  const target = path.join(root, "harness/events/head.json");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, serializeEventHead({ revision, opId, eventDigest: `sha256:${sha256Text(eventBody)}` }));
}

function commitSource(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Historical Fixture");
  git(root, "config", "user.email", "historical-fixture@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "historical fixture");
}

function slug(taskId: string): string {
  return taskId.replace(/^task_/u, "").replaceAll("_", "-");
}
