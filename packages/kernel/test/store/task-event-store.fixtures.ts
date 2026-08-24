import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type DecisionEventDraftV1 } from "../../src/domain/decision-event.ts";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "../../src/domain/migration-import-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { eventObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
import {
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";

export const event: TaskCreatedEvent = {
  schema: "task-event/v1",
  eventId: "event-1",
  workspaceRevision: 1,
  opId: "op-1",
  taskId: "task-1",
  type: "task_created",
  actor: {
    principal: { personId: "person-1" },
    executor: { kind: "agent", id: "codex" },
  },
  source: "local",
  occurredAt: "2026-08-11T00:00:00.000Z",
  payload: {
    task: {
      schema: "task/v1",
      taskId: "task-1",
      title: "Replay task",
      taskClass: "standard",
      status: "planned",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: {
        principal: { personId: "person-1" },
        executor: { kind: "agent", id: "codex" },
      },
      completionGateIds: [],
      presetSnapshotDigest: null,
    },
  },
};

// #1588: a bootstrapped repository carries harness/.gitattributes, which is what keeps a clone
// byte-faithful when the host global is core.autocrlf=true. The fixture builds its repository by
// hand, so it has to seed the same file or it measures the developer's git config, not the product.
export function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n");
  git(rootDir, "config", "user.name", "Store Test");
  git(rootDir, "config", "user.email", "store@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "add", "harness/.gitattributes");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
export function flatLedgerFixture(
  rootDir: string,
  count: number,
): { readonly parent: string; readonly blobHash: string } {
  initRepo(rootDir);
  const eventsRoot = path.join(rootDir, "harness/events"),
    objectsRoot = path.join(rootDir, "harness/objects/sha256");
  mkdirSync(eventsRoot, { recursive: true });
  mkdirSync(objectsRoot, { recursive: true });
  let last = event;
  for (let revision = 1; revision <= count; revision += 1) {
    last = eventAt(revision);
    writeFileSync(
      path.join(eventsRoot, `${last.opId}.json`),
      serializeTaskEvent(last),
    );
  }
  const bytes = serializeTaskEvent(last);
  writeFileSync(
    path.join(eventsRoot, "head.json"),
    serializeEventHead({
      revision: count,
      opId: last.opId,
      eventDigest: `sha256:${sha256Text(bytes)}`,
    }),
  );
  const blobBody = "legacy blob\n",
    blobHash = sha256Text(blobBody);
  writeFileSync(path.join(objectsRoot, blobHash), blobBody);
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "-qm", "flat ledger");
  return { parent: git(rootDir, "rev-parse", "HEAD"), blobHash };
}
export function mixedLedgerFixture(rootDir: string): {
  readonly parent: string;
  readonly flatEvents: readonly TaskCreatedEvent[];
  readonly shardedEvent: TaskCreatedEvent;
  readonly blobBodies: readonly string[];
  readonly twinHash: string;
} {
  initRepo(rootDir);
  const eventsRoot = path.join(rootDir, "harness/events"),
    objectsRoot = path.join(rootDir, "harness/objects/sha256");
  mkdirSync(eventsRoot, { recursive: true });
  mkdirSync(objectsRoot, { recursive: true });
  const flatEvents = [eventAt(1), eventAt(2)];
  for (const value of flatEvents)
    writeFileSync(
      path.join(eventsRoot, `${value.opId}.json`),
      serializeTaskEvent(value),
    );
  const twinBody = "legacy blob\n",
    twinHash = sha256Text(twinBody);
  writeFileSync(path.join(objectsRoot, twinHash), twinBody);
  const shardedEvent = eventAt(3),
    shardedEventPath = path.join(
      rootDir,
      "harness",
      eventObjectRelativePath(shardedEvent.opId),
    );
  mkdirSync(path.dirname(shardedEventPath), { recursive: true });
  writeFileSync(shardedEventPath, serializeTaskEvent(shardedEvent));
  const shardedOnlyBody = "sharded only\n",
    shardedOnlyHash = sha256Text(shardedOnlyBody),
    shardedOnlyPath = path.join(
      objectsRoot,
      shardedOnlyHash.slice(0, 2),
      shardedOnlyHash.slice(2),
    );
  mkdirSync(path.dirname(shardedOnlyPath), { recursive: true });
  writeFileSync(shardedOnlyPath, shardedOnlyBody);
  const twinShardedPath = path.join(
    objectsRoot,
    twinHash.slice(0, 2),
    twinHash.slice(2),
  );
  mkdirSync(path.dirname(twinShardedPath), { recursive: true });
  writeFileSync(twinShardedPath, twinBody);
  const bytes = serializeTaskEvent(shardedEvent);
  writeFileSync(
    path.join(eventsRoot, "head.json"),
    serializeEventHead({
      revision: 3,
      opId: shardedEvent.opId,
      eventDigest: `sha256:${sha256Text(bytes)}`,
    }),
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "-qm", "mixed ledger");
  return {
    parent: git(rootDir, "rev-parse", "HEAD"),
    flatEvents,
    shardedEvent,
    blobBodies: [twinBody, shardedOnlyBody],
    twinHash,
  };
}
export function incrementalObjectBytes(
  rootDir: string,
  parent: string,
  commit: string,
): number {
  const objects = git(
    rootDir,
    "rev-list",
    "--objects",
    "--no-object-names",
    `${parent}..${commit}`,
  )
    .split("\n")
    .filter(Boolean);
  if (!objects.length) return 0;
  const sizes = execFileSync(
    "git",
    ["-C", rootDir, "cat-file", "--batch-check=%(objectsize:disk)"],
    { input: `${objects.join("\n")}\n`, encoding: "utf8" },
  );
  return sizes
    .trim()
    .split(/\r?\n/u)
    .reduce((sum, value) => sum + Number(value), 0);
}
export function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}
export function eventAt(revision: number): TaskCreatedEvent {
  const suffix = String(revision).padStart(5, "0");
  return {
    ...event,
    eventId: `event-${suffix}`,
    workspaceRevision: revision,
    opId: `op-${suffix}`,
    taskId: `task-${suffix}`,
    payload: {
      task: {
        ...event.payload.task,
        taskId: `task-${suffix}`,
        title: `Task ${suffix}`,
      },
    },
  };
}
export function decisionProposal(): Extract<
  DecisionEventDraftV1,
  { readonly type: "decision_proposed" }
> {
  return {
    schema: "decision-event/v1",
    eventId: "event-decision-store-1",
    workspaceRevision: 1,
    opId: "op-decision-store-1",
    decisionId: "dec_STORE",
    type: "decision_proposed",
    actor: { principal: { personId: "person-proposer" }, executor: null },
    source: "local",
    occurredAt: "2026-08-14T00:00:00.000Z",
    payload: {
      title: "Store Decision",
      question: "Does one bundle own every write?",
      riskTier: "medium",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      appliesTo: { modules: ["kernel"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Use one bundle" }],
      rejected: [
        { id: "RJ1", text: "Split writes", whyNot: "They can diverge." },
      ],
      body: "\n# Store Decision\n",
      claims: [],
      fulfillments: [],
      relations: [],
      provenance: [
        {
          runtime: "unavailable",
          sessionId: null,
          transcriptReachability: "unavailable",
          boundAt: "2026-08-14T00:00:00.000Z",
        },
      ],
    },
  };
}
export function bundle(value: TaskCreatedEvent): CanonicalWriteBundle {
  return { event: value, plan: taskLifecycleWritePlan(value), blobs: [] };
}
export function docBundle(
  store: ReturnType<typeof makeTaskEventStore>,
  body: string,
  revision: number,
  opId: string,
  target: string,
): CanonicalWriteBundle {
  const hash = sha256Text(body),
    value: DocEventV1 = {
      schema: "doc-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision: revision,
      opId,
      type: "documents_written",
      actor: event.actor,
      source: "local",
      occurredAt: event.occurredAt,
      payload: {
        executionId: "execution-1",
        baseLedgerSha: store.currentCut(),
        changes: [
          {
            path: target,
            baseBlobSha256: null,
            policyId: DOC_POLICY_ID,
            candidate: {
              sha256: hash,
              size: Buffer.byteLength(body),
              mediaType: "text/markdown",
            },
            regionProofs: [
              {
                regionId: "heading/shared",
                policyId: DOC_POLICY_ID,
                codecId: DOC_CODEC_ID,
                baseSha256: sha256Text(""),
                candidateSha256: hash,
                insertBytes: Buffer.byteLength(body),
              },
            ],
          },
        ],
      },
    };
  return {
    event: value,
    plan: docSyncWritePlan(value),
    blobs: [
      {
        sha256: hash,
        size: Buffer.byteLength(body),
        mediaType: "text/markdown",
        body,
      },
    ],
  };
}
export function repoLinkBundle(
  target: string,
  body: string,
): CanonicalWriteBundle {
  const hash = sha256Text(body),
    migration: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-link",
      workspaceRevision: 1,
      opId: "op-link",
      type: "entity_migrated",
      actor: event.actor,
      source: "migration-import/v1",
      occurredAt: event.occurredAt,
      payload: {
        migratedFrom: target,
        generation: "v0",
        entity: {
          kind: "repo-document",
          nodeKind: "symbolic-link",
          documentClaim: {
            path: target,
            sha256: hash,
            size: Buffer.byteLength(body),
            mediaType: "application/vnd.harness.symbolic-link",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
          referencedContentClaims: [],
        },
      },
    };
  return {
    event: migration,
    plan: migrationImportWritePlan(migration),
    blobs: [
      {
        sha256: hash,
        size: Buffer.byteLength(body),
        mediaType: "application/vnd.harness.symbolic-link",
        body,
      },
    ],
  };
}
export function repoFileBundle(
  target: string,
  body: string,
  destinationBody: string,
): CanonicalWriteBundle {
  const hash = sha256Text(body),
    migration: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-file",
      workspaceRevision: 1,
      opId: "op-file",
      type: "entity_migrated",
      actor: event.actor,
      source: "migration-import/v1",
      occurredAt: event.occurredAt,
      payload: {
        migratedFrom: target,
        generation: "v0",
        entity: {
          kind: "repo-document",
          nodeKind: "file",
          documentClaim: {
            path: target,
            sha256: hash,
            size: Buffer.byteLength(body),
            mediaType: "text/markdown",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
          referencedContentClaims: [],
          destinationPreimage: {
            nodeKind: "file",
            sha256: sha256Text(destinationBody),
            size: Buffer.byteLength(destinationBody),
          },
        },
      },
    };
  return {
    event: migration,
    plan: migrationImportWritePlan(migration),
    blobs: [
      {
        sha256: hash,
        size: Buffer.byteLength(body),
        mediaType: "text/markdown",
        body,
      },
    ],
  };
}
export function snapshot(rootDir: string): unknown {
  const files = ["harness/context/user.md", "dirty.txt"];
  return {
    status: git(rootDir, "status", "--porcelain", "-uall"),
    index: git(rootDir, "ls-files", "-s"),
    bytes: files.map((file) =>
      readFileSync(path.join(rootDir, file)).toString("hex"),
    ),
  };
}
export function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
