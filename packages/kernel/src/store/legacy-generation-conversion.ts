import path from "node:path";
import { serializePersistedCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import { validateCurrentCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { sha256Bytes, sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import {
  decodeLegacyEventBytes,
  readStoppedLegacyGeneration,
  type StoppedLegacySourceEvidenceV1,
} from "./legacy-generation-source.ts";
import { assertNoPendingHistoricalRewrites, planLegacyGenerationConversion } from "./event-shape-migration.ts";
import { openSqliteEventStore, sqliteLedgerPath, type SqliteWriterFence } from "./sqlite-event-store.ts";
import { TaskEventStoreError, type CanonicalContentBlob, type CanonicalEventStore } from "./task-event-store-types.ts";

export interface ImmutableLegacySnapshotV1 {
  readonly schema: "immutable-legacy-generation-snapshot/v1";
  readonly repoId: string;
  readonly generation: 0;
  readonly sourceDigest: `sha256:${string}`;
  readonly eventBytes: readonly string[];
  readonly objects: readonly { readonly sha256: string; readonly size: number; readonly bytesBase64: string }[];
  readonly sourceEvidence?: StoppedLegacySourceEvidenceV1;
}

export type { StoppedLegacySourceEvidenceV1 } from "./legacy-generation-source.ts";

export interface LegacyGenerationConversionReport {
  readonly schema: "legacy-generation-conversion/v1";
  readonly repoId: string;
  readonly sourceGeneration: 0;
  readonly destinationGeneration: 1;
  readonly sourceDigest: `sha256:${string}`;
  readonly sourceEvents: number;
  readonly convertedEvents: number;
  readonly rewrittenEvents: number;
  readonly copiedObjects: number;
  readonly migratedEvents: number;
  readonly destinationRevision: number;
  readonly active: false;
}

export function legacyGenerationSnapshotPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "store", "imports", "generation-0.snapshot.json");
}

export function generationActivationCertificatePath(rootDir: string): string {
  return `${sqliteLedgerPath(rootDir, 1)}.activation.json`;
}

export function preflightCanonicalGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
}): void {
  const layout = resolveHarnessLayout(input.rootInput),
    databasePath = sqliteLedgerPath(input.rootInput, 1),
    snapshotPath = legacyGenerationSnapshotPath(layout.rootDir);
  if (!localRuntimeStateFileSystem.exists(databasePath)) {
    if (
      localRuntimeStateFileSystem.exists(path.join(layout.authoredRoot, "events")) ||
      localRuntimeStateFileSystem.exists(path.join(layout.authoredRoot, "objects"))
    )
      throw new TaskEventStoreError("invalid_store", "legacy history requires generation conversion before activation");
    initializeEmptyCanonicalGeneration(layout.rootDir, input.repoId, snapshotPath, databasePath);
    return;
  }
  const store = openSqliteEventStore({ repoId: input.repoId, databasePath, generation: 1, readOnly: true });
  const revision = store.revision();
  store.close();
  if (revision === 0 && !localRuntimeStateFileSystem.exists(snapshotPath)) {
    initializeEmptyCanonicalGeneration(layout.rootDir, input.repoId, snapshotPath, databasePath);
    return;
  }
  if (!localRuntimeStateFileSystem.exists(snapshotPath))
    throw new TaskEventStoreError("invalid_store", "nonempty generation requires its immutable source snapshot");
  preflightConvertedGenerationActivation({
    repoId: input.repoId,
    rootDir: layout.rootDir,
    snapshotPath,
    databasePath,
  });
}

function initializeEmptyCanonicalGeneration(
  rootDir: string,
  repoId: string,
  snapshotPath: string,
  databasePath: string,
): void {
  createImmutableLegacyGenerationSnapshot({ repoId, source: arraySnapshotStore([], new Map()), snapshotPath });
  convertLegacyGeneration({ rootDir, snapshotPath, databasePath });
  preflightConvertedGenerationActivation({ repoId, rootDir, snapshotPath, databasePath });
}

export function createImmutableLegacyGenerationSnapshot(input: {
  readonly repoId: string;
  readonly source: CanonicalEventStore;
  readonly snapshotPath: string;
}): { readonly sourceDigest: `sha256:${string}`; readonly eventCount: number; readonly objectCount: number } {
  const events = input.source.read().events,
    eventBytes = events.map(serializePersistedCanonicalEvent),
    claims = new Map(events.flatMap((event) => contentClaims(event).map((claim) => [claim.sha256, claim] as const))),
    objects = [...claims.values()]
      .sort((left, right) => left.sha256.localeCompare(right.sha256))
      .map((claim) => {
        const bytes = input.source.readContentBlob(claim.sha256);
        if (!bytes)
          throw new TaskEventStoreError("invalid_store", `legacy snapshot requires content object ${claim.sha256}`);
        return { sha256: claim.sha256, size: claim.size, bytesBase64: Buffer.from(bytes).toString("base64") };
      }),
    content = { repoId: input.repoId, generation: 0 as const, eventBytes, objects },
    sourceDigest = `sha256:${sha256Text(stableStringify(content))}` as const,
    body = `${JSON.stringify({
      schema: "immutable-legacy-generation-snapshot/v1",
      ...content,
      sourceDigest,
    } satisfies ImmutableLegacySnapshotV1)}\n`;
  localRuntimeStateFileSystem.mkdirp(path.dirname(input.snapshotPath));
  if (!localRuntimeStateFileSystem.createExclusiveText(input.snapshotPath, body)) {
    const existing = readSnapshot(input.snapshotPath);
    if (existing.sourceDigest !== sourceDigest)
      throw new TaskEventStoreError("invalid_store", "immutable generation snapshot already names another source");
  }
  return { sourceDigest, eventCount: events.length, objectCount: objects.length };
}

export function createImmutableLegacyGenerationSnapshotFromStoppedRepository(input: {
  readonly repoId: string;
  readonly rootInput: HarnessLayoutInput;
  readonly snapshotPath?: string;
}) {
  const layout = resolveHarnessLayout(input.rootInput),
    { eventEntries, objects, sourceEvidence } = readStoppedLegacyGeneration({ rootInput: input.rootInput }),
    objectMap = new Map(objects.map((object) => [object.sha256, object]));
  for (const entry of eventEntries)
    for (const claim of contentClaims(entry.event)) {
      const object = objectMap.get(claim.sha256);
      if (!object || object.size !== claim.size)
        throw new TaskEventStoreError("invalid_store", `legacy event requires missing object ${claim.sha256}`);
    }
  return writeRawSnapshot({
    repoId: input.repoId,
    snapshotPath: input.snapshotPath ?? legacyGenerationSnapshotPath(layout.rootDir),
    eventBytes: eventEntries.map(({ bytes }) => bytes),
    objects,
    sourceEvidence,
  });
}

export function convertLegacyGeneration(input: {
  readonly rootDir: string;
  readonly snapshotPath: string;
  readonly databasePath?: string;
  readonly fence?: SqliteWriterFence;
  readonly beforeEvent?: (revision: number) => void;
}): LegacyGenerationConversionReport {
  const snapshot = readSnapshot(input.snapshotPath),
    databasePath = input.databasePath ?? sqliteLedgerPath(input.rootDir, 1),
    markerPath = `${databasePath}.import-source.json`,
    marker = `${JSON.stringify({ schema: "generation-import-source/v1", sourceDigest: snapshot.sourceDigest })}\n`;
  if (localRuntimeStateFileSystem.exists(`${databasePath}.activation.json`))
    throw new TaskEventStoreError("invalid_store", "active generation cannot be converted");
  const plan = validatedConversionPlan(snapshot, input.rootDir);
  localRuntimeStateFileSystem.mkdirp(path.dirname(databasePath));
  if (!localRuntimeStateFileSystem.createExclusiveText(markerPath, marker)) {
    const prior = JSON.parse(localRuntimeStateFileSystem.readText(markerPath));
    if (prior.sourceDigest !== snapshot.sourceDigest)
      throw new TaskEventStoreError("invalid_store", "inactive generation was seeded from another immutable source");
  }
  const sourceObjects = new Map(
      snapshot.objects.map((object) => [object.sha256, Buffer.from(object.bytesBase64, "base64")]),
    ),
    generated = new Map(plan.blobs.map((blob) => [blob.sha256, blob])),
    store = openSqliteEventStore({ repoId: snapshot.repoId, databasePath, generation: 1 }),
    fence = input.fence ?? { repoId: snapshot.repoId, holder: "generation-converter", epoch: 1 },
    existingRevision = store.revision();
  if (existingRevision > plan.events.length) {
    store.close();
    throw new TaskEventStoreError("invalid_store", "inactive generation revision exceeds immutable source");
  }
  if (plan.events.length > 0) store.claimWriter(fence);
  try {
    for (const event of plan.events.slice(existingRevision)) {
      input.beforeEvent?.(event.workspaceRevision);
      const blobs: CanonicalContentBlob[] = contentClaims(event).map((claim) => {
        const generatedBlob = generated.get(claim.sha256),
          bytes = generatedBlob ? Buffer.from(generatedBlob.body) : sourceObjects.get(claim.sha256);
        if (!bytes)
          throw new TaskEventStoreError("invalid_store", `converted event requires missing object ${claim.sha256}`);
        return {
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
          body: generatedBlob?.body ?? new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      });
      const eventJson = serializePersistedCanonicalEvent(event);
      store.appendCommand({
        fence,
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(eventJson)}`,
          summary: event.type,
        },
        events: [event],
        blobs,
      });
    }
    const stored = store.eventRows();
    for (const [index, event] of plan.events.entries())
      if (stored[index]?.eventJson !== serializePersistedCanonicalEvent(event))
        throw new TaskEventStoreError("invalid_store", `converted event differs at revision ${index + 1}`);
    return {
      schema: "legacy-generation-conversion/v1",
      repoId: snapshot.repoId,
      sourceGeneration: 0,
      destinationGeneration: 1,
      sourceDigest: snapshot.sourceDigest,
      sourceEvents: snapshot.eventBytes.length,
      convertedEvents: plan.events.length,
      rewrittenEvents: plan.rewrites.length,
      copiedObjects: store.contentObjectDigests().length,
      migratedEvents: plan.events.length - existingRevision,
      destinationRevision: store.revision(),
      active: false,
    };
  } finally {
    store.close();
  }
}

export function readImmutableLegacyGenerationSnapshot(snapshotPath: string): ImmutableLegacySnapshotV1 {
  return readSnapshot(snapshotPath);
}

export function planLegacyGenerationSnapshotConversion(input: {
  readonly rootDir: string;
  readonly snapshotPath: string;
}) {
  const snapshot = readSnapshot(input.snapshotPath),
    plan = validatedConversionPlan(snapshot, input.rootDir);
  return { snapshot, plan };
}

export function preflightConvertedGenerationActivation(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly snapshotPath: string;
  readonly databasePath?: string;
}): void {
  const databasePath = input.databasePath ?? sqliteLedgerPath(input.rootDir, 1),
    { snapshot, plan } = planLegacyGenerationSnapshotConversion(input);
  if (snapshot.repoId !== input.repoId)
    throw new TaskEventStoreError("repo_mismatch", "immutable snapshot belongs to another repository");
  const marker = JSON.parse(localRuntimeStateFileSystem.readText(`${databasePath}.import-source.json`));
  if (marker.sourceDigest !== snapshot.sourceDigest)
    throw new TaskEventStoreError("invalid_store", "generation import marker differs from immutable source");
  const store = openSqliteEventStore({ repoId: input.repoId, databasePath, generation: 1, readOnly: true });
  try {
    const rows = store.eventRows();
    if (
      rows.length < plan.events.length ||
      rows
        .slice(0, plan.events.length)
        .some((row, index) => row.eventJson !== serializePersistedCanonicalEvent(plan.events[index]!))
    )
      throw new TaskEventStoreError("invalid_store", "generation conversion is incomplete");
    const events = rows.map(
      (row) => decodeLegacyEventBytes(row.eventJson, `generation revision ${row.revision}`).event,
    );
    for (const event of events) {
      const issues = validateCurrentCanonicalEvent(event);
      if (issues.length > 0)
        throw new TaskEventStoreError(
          "invalid_store",
          `generation event ${event.opId} is not current: ${issues.join("; ")}`,
        );
      for (const claim of contentClaims(event)) {
        const bytes = store.readContentObject(claim.sha256);
        if (bytes === null || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
          throw new TaskEventStoreError("invalid_store", `generation conversion has invalid object ${claim.sha256}`);
      }
    }
    assertNoPendingHistoricalRewrites({ rootDir: input.rootDir, store: sqliteSnapshotStore(store) });
    const certificatePath = `${databasePath}.activation.json`,
      certificate = `${JSON.stringify({
        schema: "generation-activation/v1",
        repoId: input.repoId,
        sourceDigest: snapshot.sourceDigest,
        importedPrefixRevision: plan.events.length,
      })}\n`;
    if (!localRuntimeStateFileSystem.createExclusiveText(certificatePath, certificate)) {
      const existing = JSON.parse(localRuntimeStateFileSystem.readText(certificatePath));
      if (
        existing.repoId !== input.repoId ||
        existing.sourceDigest !== snapshot.sourceDigest ||
        existing.importedPrefixRevision !== plan.events.length
      )
        throw new TaskEventStoreError("invalid_store", "generation activation certificate differs");
    }
  } finally {
    store.close();
  }
}

function validatedConversionPlan(snapshot: ImmutableLegacySnapshotV1, rootDir: string) {
  const plan = planLegacyGenerationConversion({ rootDir, store: snapshotStore(snapshot) });
  for (const event of plan.events) {
    serializePersistedCanonicalEvent(event);
    const issues = validateCurrentCanonicalEvent(event);
    if (issues.length > 0)
      throw new TaskEventStoreError(
        "invalid_store",
        `converted event ${event.opId} is not current: ${issues.join("; ")}`,
      );
  }
  assertNoPendingHistoricalRewrites({
    rootDir,
    store: convertedPlanStore(snapshot, plan.events, plan.blobs),
  });
  return plan;
}

function readSnapshot(snapshotPath: string): ImmutableLegacySnapshotV1 {
  const value = JSON.parse(localRuntimeStateFileSystem.readText(snapshotPath)) as ImmutableLegacySnapshotV1;
  if (value.schema !== "immutable-legacy-generation-snapshot/v1" || value.generation !== 0)
    throw new TaskEventStoreError("invalid_store", "legacy generation snapshot has the wrong schema");
  const content = {
      repoId: value.repoId,
      generation: value.generation,
      eventBytes: value.eventBytes,
      objects: value.objects,
      ...(value.sourceEvidence ? { sourceEvidence: value.sourceEvidence } : {}),
    },
    digest = `sha256:${sha256Text(stableStringify(content))}`;
  if (digest !== value.sourceDigest)
    throw new TaskEventStoreError("invalid_store", "legacy generation snapshot digest differs");
  return value;
}

function snapshotStore(snapshot: ImmutableLegacySnapshotV1): CanonicalEventStore {
  const events = snapshot.eventBytes.map(
      (body, index) => decodeLegacyEventBytes(body, `snapshot revision ${index + 1}`).event,
    ),
    objects = new Map(snapshot.objects.map((object) => [object.sha256, Buffer.from(object.bytesBase64, "base64")]));
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () =>
      events.length === 0
        ? null
        : { revision: events.length, eventDigest: `sha256:${sha256Text(snapshot.eventBytes.at(-1)!)}` },
    readBatch: () => ({
      sourceRevision: events.length,
      events,
      cursor: null,
      done: true,
      accessedItems: events.length,
      prefetchContent: () => objects,
    }),
    readContentBlob: (sha256: string) => objects.get(sha256) ?? null,
  } as unknown as CanonicalEventStore;
}

function writeRawSnapshot(input: {
  readonly repoId: string;
  readonly snapshotPath: string;
  readonly eventBytes: readonly string[];
  readonly objects: ImmutableLegacySnapshotV1["objects"];
  readonly sourceEvidence: StoppedLegacySourceEvidenceV1;
}) {
  const content = {
      repoId: input.repoId,
      generation: 0 as const,
      eventBytes: input.eventBytes,
      objects: input.objects,
      sourceEvidence: input.sourceEvidence,
    },
    sourceDigest = `sha256:${sha256Text(stableStringify(content))}` as const,
    body = `${JSON.stringify({ schema: "immutable-legacy-generation-snapshot/v1", ...content, sourceDigest })}\n`;
  localRuntimeStateFileSystem.mkdirp(path.dirname(input.snapshotPath));
  if (!localRuntimeStateFileSystem.createExclusiveText(input.snapshotPath, body)) {
    const existing = readSnapshot(input.snapshotPath);
    if (existing.sourceDigest !== sourceDigest)
      throw new TaskEventStoreError("invalid_store", "immutable generation snapshot already names another source");
  }
  return {
    sourceDigest,
    eventCount: input.eventBytes.length,
    objectCount: input.objects.length,
    sourceEvidence: input.sourceEvidence,
  };
}

function sqliteSnapshotStore(store: ReturnType<typeof openSqliteEventStore>): CanonicalEventStore {
  const events = store.events(),
    objects = new Map(store.contentObjectDigests().map((sha256) => [sha256, store.readContentObject(sha256)!]));
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () =>
      events.length === 0
        ? null
        : {
            revision: events.length,
            eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(events.at(-1)!))}`,
          },
    readBatch: () => ({
      sourceRevision: events.length,
      events,
      cursor: null,
      done: true,
      accessedItems: events.length,
      prefetchContent: () => objects,
    }),
    readContentBlob: (sha256: string) => objects.get(sha256) ?? null,
  } as unknown as CanonicalEventStore;
}

function convertedPlanStore(
  snapshot: ImmutableLegacySnapshotV1,
  events: readonly CanonicalEventV1[],
  generatedBlobs: readonly CanonicalContentBlob[],
): CanonicalEventStore {
  const objects = new Map(snapshot.objects.map((object) => [object.sha256, Buffer.from(object.bytesBase64, "base64")]));
  for (const blob of generatedBlobs) objects.set(blob.sha256, Buffer.from(blob.body));
  return arraySnapshotStore(events, objects);
}

function arraySnapshotStore(
  events: readonly CanonicalEventV1[],
  objects: ReadonlyMap<string, Uint8Array>,
): CanonicalEventStore {
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () =>
      events.length === 0
        ? null
        : {
            revision: events.length,
            eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(events.at(-1)!))}`,
          },
    readBatch: () => ({
      sourceRevision: events.length,
      events,
      cursor: null,
      done: true,
      accessedItems: events.length,
      prefetchContent: () => objects,
    }),
    readContentBlob: (sha256: string) => objects.get(sha256) ?? null,
  } as unknown as CanonicalEventStore;
}
