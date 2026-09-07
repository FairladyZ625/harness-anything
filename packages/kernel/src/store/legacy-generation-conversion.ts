import { createHash } from "node:crypto";
import path from "node:path";
import { serializePersistedCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import { validateCurrentCanonicalEvent } from "../domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { sha256Bytes, sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localEvidenceFileSystem, localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import {
  decodeLegacyEventBytes,
  readStoppedLegacyGeneration,
  type StoppedLegacySourceEvidenceV1,
} from "./legacy-generation-source.ts";
import { assertNoPendingHistoricalRewrites, planLegacyGenerationConversion } from "./event-shape-migration.ts";
import { openSqliteEventStore, sqliteLedgerPath, type SqliteWriterFence } from "./sqlite-event-store.ts";
import { TaskEventStoreError, type CanonicalContentBlob, type CanonicalEventStore } from "./task-event-store-types.ts";

export interface ImmutableLegacySnapshotV2 {
  readonly schema: "immutable-legacy-generation-snapshot/v2";
  readonly repoId: string;
  readonly generation: 0;
  readonly sourceDigest: `sha256:${string}`;
  readonly eventBytes: readonly string[];
  readonly eventSegments: readonly {
    readonly firstRevision: number;
    readonly count: number;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly objects: readonly { readonly sha256: string; readonly size: number }[];
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
  readonly migrationFamilies: ReturnType<typeof planLegacyGenerationConversion>["migrationFamilies"];
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
    certificatePath = generationActivationCertificatePath(layout.rootDir),
    markerPath = `${databasePath}.import-source.json`;
  if (
    !localRuntimeStateFileSystem.exists(databasePath) ||
    !localRuntimeStateFileSystem.exists(markerPath) ||
    !localRuntimeStateFileSystem.exists(certificatePath)
  )
    throw new TaskEventStoreError(
      "invalid_store",
      "canonical generation is not activated; run operator conversion before attaching this repository",
    );
  const marker = JSON.parse(localRuntimeStateFileSystem.readText(markerPath)),
    certificate = JSON.parse(localRuntimeStateFileSystem.readText(certificatePath));
  if (
    certificate.schema !== "generation-activation/v1" ||
    certificate.repoId !== input.repoId ||
    certificate.sourceDigest !== marker.sourceDigest ||
    !Number.isSafeInteger(certificate.importedPrefixRevision) ||
    certificate.importedPrefixRevision < 0
  )
    throw new TaskEventStoreError("invalid_store", "generation activation certificate differs");
  const store = openSqliteEventStore({ repoId: input.repoId, databasePath, generation: 1, readOnly: true });
  try {
    if (store.revision() < certificate.importedPrefixRevision)
      throw new TaskEventStoreError("invalid_store", "generation revision precedes its activation certificate");
  } finally {
    store.close();
  }
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
      .map(({ sha256, size }) => ({ sha256, size })),
    eventSegments = snapshotEventSegments(eventBytes),
    sourceDigest = snapshotSourceDigest(input.repoId, eventBytes, objects),
    body = `${JSON.stringify({
      schema: "immutable-legacy-generation-snapshot/v2",
      repoId: input.repoId,
      generation: 0,
      eventSegments,
      objects,
      sourceDigest,
    })}\n`;
  localRuntimeStateFileSystem.mkdirp(path.dirname(input.snapshotPath));
  if (localRuntimeStateFileSystem.exists(input.snapshotPath)) {
    const existing = readLegacySnapshot(input.snapshotPath);
    if (existing.sourceDigest !== sourceDigest)
      throw new TaskEventStoreError("invalid_store", "immutable generation snapshot already names another source");
    return { sourceDigest, eventCount: events.length, objectCount: objects.length };
  }
  writeSnapshotEvents(input.snapshotPath, eventBytes, eventSegments);
  localRuntimeStateFileSystem.mkdirp(snapshotObjectsPath(input.snapshotPath));
  for (const object of objects) {
    const bytes = input.source.readContentBlob(object.sha256);
    if (!bytes)
      throw new TaskEventStoreError("invalid_store", `legacy snapshot requires content object ${object.sha256}`);
    writeSnapshotObject(input.snapshotPath, { ...object, bytes });
  }
  localRuntimeStateFileSystem.syncDirectory(snapshotObjectsPath(input.snapshotPath));
  if (!localRuntimeStateFileSystem.createExclusiveText(input.snapshotPath, body)) {
    const existing = readLegacySnapshot(input.snapshotPath);
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
  const snapshot = readLegacySnapshot(input.snapshotPath),
    databasePath = input.databasePath ?? sqliteLedgerPath(input.rootDir, 1),
    markerPath = `${databasePath}.import-source.json`,
    marker = `${JSON.stringify({ schema: "generation-import-source/v1", sourceDigest: snapshot.sourceDigest })}\n`;
  if (localRuntimeStateFileSystem.exists(`${databasePath}.activation.json`))
    throw new TaskEventStoreError("invalid_store", "active generation cannot be converted");
  const plan = validatedConversionPlan(snapshot, input.rootDir, input.snapshotPath);
  localRuntimeStateFileSystem.mkdirp(path.dirname(databasePath));
  if (!localRuntimeStateFileSystem.createExclusiveText(markerPath, marker)) {
    const prior = JSON.parse(localRuntimeStateFileSystem.readText(markerPath));
    if (prior.sourceDigest !== snapshot.sourceDigest)
      throw new TaskEventStoreError("invalid_store", "inactive generation was seeded from another immutable source");
  }
  const generated = new Map(plan.blobs.map((blob) => [blob.sha256, blob])),
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
          bytes = generatedBlob
            ? Buffer.from(generatedBlob.body)
            : readSnapshotObject(input.snapshotPath, claim.sha256, claim.size);
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
      migrationFamilies: plan.migrationFamilies,
      copiedObjects: store.contentObjectDigests().length,
      migratedEvents: plan.events.length - existingRevision,
      destinationRevision: store.revision(),
      active: false,
    };
  } finally {
    store.close();
  }
}

export function readImmutableLegacyGenerationSnapshot(snapshotPath: string): ImmutableLegacySnapshotV2 {
  return readLegacySnapshot(snapshotPath);
}

export function planLegacyGenerationSnapshotConversion(input: {
  readonly rootDir: string;
  readonly snapshotPath: string;
}) {
  const snapshot = readLegacySnapshot(input.snapshotPath),
    plan = validatedConversionPlan(snapshot, input.rootDir, input.snapshotPath);
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

function validatedConversionPlan(snapshot: ImmutableLegacySnapshotV2, rootDir: string, snapshotPath: string) {
  const plan = planLegacyGenerationConversion({ rootDir, store: snapshotStore(snapshot, snapshotPath) });
  for (const event of plan.events) {
    serializePersistedCanonicalEvent(event);
    const issues = validateCurrentCanonicalEvent(event);
    if (issues.length > 0)
      throw new TaskEventStoreError(
        "invalid_store",
        `converted event ${event.opId} is not current: ${issues.join("; ")}`,
      );
  }
  return plan;
}

function readLegacySnapshot(snapshotPath: string): ImmutableLegacySnapshotV2 {
  const value = JSON.parse(localRuntimeStateFileSystem.readText(snapshotPath)) as Omit<
    ImmutableLegacySnapshotV2,
    "eventBytes"
  >;
  if (value.schema !== "immutable-legacy-generation-snapshot/v2" || value.generation !== 0)
    throw new TaskEventStoreError("invalid_store", "legacy generation snapshot has the wrong schema");
  const eventBytes = readSnapshotEvents(snapshotPath, value.eventSegments),
    digest = snapshotSourceDigest(value.repoId, eventBytes, value.objects, value.sourceEvidence);
  if (digest !== value.sourceDigest)
    throw new TaskEventStoreError("invalid_store", "legacy generation snapshot digest differs");
  for (const object of value.objects) readSnapshotObject(snapshotPath, object.sha256, object.size);
  return { ...value, eventBytes };
}

function snapshotStore(snapshot: ImmutableLegacySnapshotV2, snapshotPath: string): CanonicalEventStore {
  const objects = new Map(snapshot.objects.map((object) => [object.sha256, object])),
    events = snapshot.eventBytes.map(
      (body, index) => decodeLegacyEventBytes(body, `snapshot revision ${index + 1}`).event,
    );
  return arraySnapshotStore(events, (sha256) => {
    const object = objects.get(sha256);
    return object ? readSnapshotObject(snapshotPath, sha256, object.size) : null;
  });
}

function writeRawSnapshot(input: {
  readonly repoId: string;
  readonly snapshotPath: string;
  readonly eventBytes: readonly string[];
  readonly objects: readonly { readonly sha256: string; readonly size: number; readonly bytes: Uint8Array }[];
  readonly sourceEvidence: StoppedLegacySourceEvidenceV1;
}) {
  const content = {
      repoId: input.repoId,
      generation: 0 as const,
      eventSegments: snapshotEventSegments(input.eventBytes),
      objects: input.objects.map(({ sha256, size }) => ({ sha256, size })),
      sourceEvidence: input.sourceEvidence,
    },
    sourceDigest = snapshotSourceDigest(input.repoId, input.eventBytes, content.objects, input.sourceEvidence),
    body = `${JSON.stringify({ schema: "immutable-legacy-generation-snapshot/v2", ...content, sourceDigest })}\n`;
  localRuntimeStateFileSystem.mkdirp(path.dirname(input.snapshotPath));
  if (localRuntimeStateFileSystem.exists(input.snapshotPath)) {
    const existing = readLegacySnapshot(input.snapshotPath);
    if (existing.sourceDigest !== sourceDigest)
      throw new TaskEventStoreError("invalid_store", "immutable generation snapshot already names another source");
    return {
      sourceDigest,
      eventCount: input.eventBytes.length,
      objectCount: input.objects.length,
      sourceEvidence: input.sourceEvidence,
    };
  }
  writeSnapshotEvents(input.snapshotPath, input.eventBytes, content.eventSegments);
  writeSnapshotObjects(input.snapshotPath, input.objects);
  if (!localRuntimeStateFileSystem.createExclusiveText(input.snapshotPath, body)) {
    const existing = readLegacySnapshot(input.snapshotPath);
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
  return arraySnapshotStore(store.events(), (sha256) => store.readContentObject(sha256));
}

function snapshotSourceDigest(
  repoId: string,
  eventBytes: readonly string[],
  objects: ImmutableLegacySnapshotV2["objects"],
  sourceEvidence?: StoppedLegacySourceEvidenceV1,
): `sha256:${string}` {
  const hash = createHash("sha256");
  hash.update(stableStringify({ repoId, generation: 0 }), "utf8");
  for (const event of eventBytes) hash.update(stableStringify(event), "utf8");
  for (const object of objects) hash.update(stableStringify(object), "utf8");
  if (sourceEvidence) hash.update(stableStringify(sourceEvidence), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function snapshotObjectsPath(snapshotPath: string): string {
  return `${snapshotPath}.objects`;
}

const SNAPSHOT_EVENT_SEGMENT_SIZE = 512;

function snapshotEventsPath(snapshotPath: string): string {
  return `${snapshotPath}.events`;
}

function snapshotEventSegments(eventBytes: readonly string[]): ImmutableLegacySnapshotV2["eventSegments"] {
  const segments: Array<ImmutableLegacySnapshotV2["eventSegments"][number]> = [];
  for (let offset = 0; offset < eventBytes.length; offset += SNAPSHOT_EVENT_SEGMENT_SIZE) {
    const body = `${JSON.stringify(eventBytes.slice(offset, offset + SNAPSHOT_EVENT_SEGMENT_SIZE))}\n`;
    segments.push({
      firstRevision: offset + 1,
      count: Math.min(SNAPSHOT_EVENT_SEGMENT_SIZE, eventBytes.length - offset),
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
    });
  }
  return segments;
}

function writeSnapshotEvents(
  snapshotPath: string,
  eventBytes: readonly string[],
  segments: ImmutableLegacySnapshotV2["eventSegments"],
): void {
  const eventsPath = snapshotEventsPath(snapshotPath);
  localRuntimeStateFileSystem.mkdirp(eventsPath);
  for (const segment of segments) {
    const offset = segment.firstRevision - 1,
      body = `${JSON.stringify(eventBytes.slice(offset, offset + segment.count))}\n`,
      segmentPath = path.join(eventsPath, `${segment.firstRevision}.json`);
    if (!localRuntimeStateFileSystem.createExclusiveText(segmentPath, body, false)) {
      const existing = localRuntimeStateFileSystem.readText(segmentPath);
      if (Buffer.byteLength(existing) !== segment.size || sha256Text(existing) !== segment.sha256)
        throw new TaskEventStoreError(
          "invalid_store",
          `legacy snapshot event segment ${segment.firstRevision} differs`,
        );
    }
  }
  localRuntimeStateFileSystem.syncDirectory(eventsPath);
}

function readSnapshotEvents(
  snapshotPath: string,
  segments: ImmutableLegacySnapshotV2["eventSegments"],
): readonly string[] {
  const eventBytes: string[] = [];
  for (const segment of segments) {
    if (segment.firstRevision !== eventBytes.length + 1 || segment.count < 1)
      throw new TaskEventStoreError("invalid_store", "legacy snapshot event segments are discontinuous");
    const segmentPath = path.join(snapshotEventsPath(snapshotPath), `${segment.firstRevision}.json`);
    if (!localRuntimeStateFileSystem.exists(segmentPath))
      throw new TaskEventStoreError("invalid_store", `legacy snapshot requires event segment ${segment.firstRevision}`);
    const body = localRuntimeStateFileSystem.readText(segmentPath);
    if (Buffer.byteLength(body) !== segment.size || sha256Text(body) !== segment.sha256)
      throw new TaskEventStoreError("invalid_store", `legacy snapshot event segment ${segment.firstRevision} differs`);
    const events = JSON.parse(body) as readonly string[];
    if (events.length !== segment.count || events.some((event) => typeof event !== "string"))
      throw new TaskEventStoreError(
        "invalid_store",
        `legacy snapshot event segment ${segment.firstRevision} is invalid`,
      );
    eventBytes.push(...events);
  }
  return eventBytes;
}

function writeSnapshotObjects(
  snapshotPath: string,
  objects: readonly { readonly sha256: string; readonly size: number; readonly bytes: Uint8Array }[],
): void {
  const objectsPath = snapshotObjectsPath(snapshotPath);
  localRuntimeStateFileSystem.mkdirp(objectsPath);
  for (const object of objects) writeSnapshotObject(snapshotPath, object);
  localRuntimeStateFileSystem.syncDirectory(objectsPath);
}

function writeSnapshotObject(
  snapshotPath: string,
  object: { readonly sha256: string; readonly size: number; readonly bytes: Uint8Array },
): void {
  if (object.bytes.byteLength !== object.size || sha256Bytes(object.bytes) !== object.sha256)
    throw new TaskEventStoreError("invalid_store", `legacy snapshot content object ${object.sha256} differs`);
  localRuntimeStateFileSystem.mkdirp(snapshotObjectsPath(snapshotPath));
  const objectPath = path.join(snapshotObjectsPath(snapshotPath), object.sha256);
  if (!localRuntimeStateFileSystem.createExclusiveText(objectPath, object.bytes, false))
    readSnapshotObject(snapshotPath, object.sha256, object.size);
}

function readSnapshotObject(snapshotPath: string, sha256: string, size: number): Uint8Array {
  const objectPath = path.join(snapshotObjectsPath(snapshotPath), sha256);
  if (!localEvidenceFileSystem.exists(objectPath))
    throw new TaskEventStoreError("invalid_store", `legacy snapshot requires content object ${sha256}`);
  const bytes = localEvidenceFileSystem.readBytes(objectPath);
  if (bytes.byteLength !== size || sha256Bytes(bytes) !== sha256)
    throw new TaskEventStoreError("invalid_store", `legacy snapshot content object ${sha256} differs`);
  return bytes;
}

function arraySnapshotStore(
  events: readonly CanonicalEventV1[],
  objects: ReadonlyMap<string, Uint8Array> | ((sha256: string) => Uint8Array | null),
): CanonicalEventStore {
  const readContent = typeof objects === "function" ? objects : (sha256: string) => objects.get(sha256) ?? null;
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
      prefetchContent: (replay: readonly CanonicalEventV1[]) =>
        new Map(
          replay.flatMap((event) =>
            contentClaims(event).map((claim) => [claim.sha256, readContent(claim.sha256)!] as const),
          ),
        ),
    }),
    readContentBlob: readContent,
  } as unknown as CanonicalEventStore;
}
