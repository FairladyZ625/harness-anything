import path from "node:path";
import { Schema } from "effect";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { readAttributionEvents } from "../local/attribution-event-source.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import { AttributionEventSchema, type AttributionEvent } from "../schemas/attribution-event.ts";
import { resolveCommitPlan } from "./write-journal-git.ts";
import type { JournalRecordV2 } from "./write-journal-types.ts";
import { appendImmutableJsonLineDurably, durableFileExists, readFileBytes } from "./write-journal-durable.ts";

export interface AttributionEventStoreContext {
  readonly rootDir: string;
  readonly rootInput: HarnessLayoutInput;
  readonly commitSha: string;
  readonly versionControlSystem: VersionControlSystem;
  readonly recordedAt?: string;
}

export interface AttributionEventStore {
  readonly ensure: (record: JournalRecordV2, context: AttributionEventStoreContext) => AttributionEventWrite;
  readonly confirms: (event: AttributionEvent, context: AttributionEventStoreContext) => boolean;
  readonly readAll: (rootInput: HarnessLayoutInput) => ReadonlyArray<AttributionEvent>;
}

export interface AttributionEventWrite {
  readonly event: AttributionEvent;
  readonly touchedPaths: ReadonlyArray<string>;
}

export function planAttributionEventCommit(
  rootDir: string,
  rootInput: HarnessLayoutInput,
  touchedPaths: ReadonlyArray<string>,
  versionControlSystem: VersionControlSystem
): { readonly willCommit: boolean; readonly preCommitSha: string } {
  const plan = resolveCommitPlan(rootDir, touchedPaths, rootInput, versionControlSystem);
  if (plan) {
    return {
      willCommit: versionControlSystem.workingTreeFiles(plan.repoRoot, plan.relativePaths).trim().length > 0,
      preCommitSha: versionControlSystem.currentHead(plan.repoRoot)
    };
  }
  const localRoot = resolveHarnessLayout(rootInput).localRoot;
  return {
    willCommit: touchedPaths.some((filePath) => !isLocalRuntimePath(localRoot, filePath)),
    preCommitSha: "no-git-change"
  };
}

export function makeLocalGitAttributionEventStore(): AttributionEventStore {
  return {
    ensure: ensureLocalAttributionEvent,
    confirms: localEventIsDurable,
    readAll: readAttributionEvents
  };
}

export function createAttributionEvent(record: JournalRecordV2): AttributionEvent {
  return createAttributionEventRecordedAt(record, record.at);
}

function createAttributionEventRecordedAt(record: JournalRecordV2, recordedAt: string): AttributionEvent {
  if (!record.payloadRef || typeof record.payload?.payloadHash !== "string") {
    throw new Error(`attributed journal record ${record.opId} lacks immutable payload evidence`);
  }
  return Schema.decodeUnknownSync(AttributionEventSchema)({
    schema: "attribution-event/v1",
    eventId: `attribution:${record.opId}`,
    opId: record.opId,
    journalRecordSchema: record.schema,
    entityId: record.entityId,
    kind: record.kind,
    actor: record.actor,
    principalSource: record.principalSource,
    executorSource: record.executorSource,
    at: record.at,
    recordedAt,
    payloadHash: record.payload.payloadHash,
    payloadRef: record.payloadRef,
    ...(record.authorityIntegrity ? { authorityIntegrity: record.authorityIntegrity } : {})
  });
}

function ensureLocalAttributionEvent(record: JournalRecordV2, context: AttributionEventStoreContext): AttributionEventWrite {
  const event = createAttributionEventRecordedAt(record, context.recordedAt ?? record.at);
  const eventPath = localEventPath(context.rootInput, event.opId);
  if (eventExistsAtCommit(eventPath, context)) return { event, touchedPaths: [] };
  if (durableFileExists(eventPath)) {
    assertSameEvent(decodeEvent(readAttributionEventText(eventPath)), event);
    return { event, touchedPaths: [eventPath] };
  }
  if (!appendImmutableJsonLineDurably(eventPath, event)) {
    assertSameEvent(decodeEvent(readAttributionEventText(eventPath)), event);
  }
  return { event, touchedPaths: [eventPath] };
}

function localEventIsDurable(event: AttributionEvent, context: AttributionEventStoreContext): boolean {
  const eventPath = localEventPath(context.rootInput, event.opId);
  if (eventExistsAtCommit(eventPath, context)) return true;
  if (!durableFileExists(eventPath)) return false;
  try {
    assertSameEvent(decodeEvent(readAttributionEventText(eventPath)), event);
    return resolveCommitPlan(context.rootDir, [eventPath], context.rootInput, context.versionControlSystem) === null;
  } catch {
    return false;
  }
}

function eventExistsAtCommit(eventPath: string, context: AttributionEventStoreContext): boolean {
  const plan = resolveCommitPlan(context.rootDir, [eventPath], context.rootInput, context.versionControlSystem);
  return plan !== null &&
    context.versionControlSystem.commitExists(plan.repoRoot, context.commitSha) &&
    plan.relativePaths.every((relativePath) => context.versionControlSystem.pathExistsAtCommit(plan.repoRoot, context.commitSha, relativePath));
}

function localEventPath(rootInput: HarnessLayoutInput, opId: string): string {
  return path.join(resolveHarnessLayout(rootInput).attributionEventsRoot, `${sha256Text(opId)}.jsonl`);
}

function decodeEvent(body: string): AttributionEvent {
  const lines = body.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("immutable attribution event shard must contain exactly one event");
  return Schema.decodeUnknownSync(AttributionEventSchema)(JSON.parse(lines[0]!));
}

function assertSameEvent(existing: AttributionEvent, candidate: AttributionEvent): void {
  if (existing.opId !== candidate.opId || stableStringify(existing) !== stableStringify(candidate)) {
    throw new Error(`attribution event collision for op ${candidate.opId}`);
  }
}

function readAttributionEventText(filePath: string): string {
  return Buffer.from(readFileBytes(filePath)).toString("utf8");
}

function isLocalRuntimePath(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return relativePath.length === 0 || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}
