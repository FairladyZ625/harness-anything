import path from "node:path";
import {
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import { isRetiredCiRunObservationEvent } from "@harness-anything/kernel/internal/domain/ci-run-observation-retired-event.ts";
import { DECISION_DOCUMENT_POLICY_ID } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  isDecisionEvent,
  isDocEvent,
  isMigrationImportEvent,
  isRelationEvent,
  isTaskEvent,
  type DocumentState,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  canonicalEventSchemas,
  isUnknownForwardCanonicalEventType,
} from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { isDossierSynthesisEvent } from "@harness-anything/kernel/internal/domain/dossier-synthesis-event.ts";
import { isEntityDocumentEvent } from "@harness-anything/kernel/internal/domain/entity-document-event.ts";
import {
  isEntityDeclarationEvent,
  isEntityEvent,
  ownedContentForDeclarationEvent,
} from "@harness-anything/kernel/internal/domain/entity-event.ts";
import {
  ENTITY_CONTENT_POLICY_ID,
  entityOwnedDocumentClaims,
} from "@harness-anything/kernel/internal/domain/entity-owned-content.ts";
import { normalizeHistoricalEvent } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { isRetiredPeopleEvent } from "@harness-anything/kernel/internal/domain/people-event.ts";
import { isPresetSnapshotUpgradeEvent } from "@harness-anything/kernel/internal/domain/preset-snapshot-upgrade-event.ts";
import { isScheduleEvent } from "@harness-anything/kernel/internal/domain/schedule-event.ts";
import { isSettingsEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import { isTaskBootstrapEvent } from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import { isTaskProgressEvent } from "@harness-anything/kernel/internal/domain/task-progress-event.ts";
import { isVerticalDeclarationEvent } from "@harness-anything/kernel/internal/domain/vertical-declaration.ts";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import { contentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import type {
  EventContentPrefetch,
  EventStreamPort,
} from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import { readContentObject } from "../store/content-objects.ts";
import { canonicalJson } from "./rebuildable-task-projection-sql.ts";

export const decisionDocumentPattern = /^decisions\/decision-(dec_[A-Za-z0-9_-]+)\/decision\.md$/u;

export type ProjectionContentBlobErrorCode = "content_blob_missing" | "content_blob_digest_mismatch";

export class ProjectionContentBlobError extends Error {
  readonly code: ProjectionContentBlobErrorCode;
  readonly documentPath: string;
  readonly blobSha256: string;

  constructor(code: ProjectionContentBlobErrorCode, documentPath: string, blobSha256: string, message: string) {
    super(message);
    this.name = "ProjectionContentBlobError";
    this.code = code;
    this.documentPath = documentPath;
    this.blobSha256 = blobSha256;
  }
}

export type ProjectedDocumentMetadata = Omit<DocumentState, "body">;

export function stripDocumentBody(
  document: ProjectedDocumentMetadata & { readonly body?: unknown },
): ProjectedDocumentMetadata {
  return {
    path: document.path,
    blobSha256: document.blobSha256,
    size: document.size,
    mediaType: document.mediaType,
    policyId: document.policyId,
    workspaceRevision: document.workspaceRevision,
  };
}

export function serializeProjectedDocument(document: ProjectedDocumentMetadata & { readonly body?: unknown }): string {
  return canonicalJson(stripDocumentBody(document));
}

export function isNonTextualDocumentPolicy(policyId: string | null | undefined): boolean {
  return policyId === RAW_ARTIFACT_POLICY_ID || policyId === ENTITY_CONTENT_POLICY_ID;
}

/**
 * Hydrate a projected document row into a full DocumentState.
 * Schema v40 rows omit `body` and resolve bytes on demand from immutable CAS with strict L3
 * fail-closed checks (missing blob or size/SHA-256/UTF-8 mismatch always throws explicitly).
 */
export function hydrateDocumentRow(valueJson: string, readBlob?: EventStreamPort["readContentBlob"]): DocumentState {
  const parsed = JSON.parse(valueJson) as ProjectedDocumentMetadata & { readonly body?: unknown };
  if (typeof parsed.body === "string") return parsed as DocumentState;
  const documentPath = String(parsed.path ?? "");
  const blobSha256 = String(parsed.blobSha256 ?? "");
  const expectedSize = Number(parsed.size);
  const bytes = readBlob?.(blobSha256) ?? null;
  if (bytes === null) {
    throw new ProjectionContentBlobError(
      "content_blob_missing",
      documentPath,
      blobSha256,
      `content blob ${blobSha256} is missing for projected document ${documentPath}`,
    );
  }
  const actualSha256 = sha256Bytes(bytes);
  if (bytes.byteLength !== expectedSize || actualSha256 !== blobSha256) {
    throw new ProjectionContentBlobError(
      "content_blob_digest_mismatch",
      documentPath,
      blobSha256,
      `content blob integrity mismatch for projected document ${documentPath}: ` +
        `expected ${blobSha256} (${expectedSize} bytes), observed ${actualSha256} (${bytes.byteLength} bytes)`,
    );
  }
  if (isNonTextualDocumentPolicy(parsed.policyId)) {
    return { ...stripDocumentBody(parsed), body: "" };
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: parsed.policyId === OPAQUE_TEXTUAL_POLICY_ID,
    }).decode(bytes);
  } catch {
    throw new ProjectionContentBlobError(
      "content_blob_digest_mismatch",
      documentPath,
      blobSha256,
      `content blob ${blobSha256} for projected document ${documentPath} is not valid UTF-8`,
    );
  }
  return { ...stripDocumentBody(parsed), body };
}

/**
 * Resolve a read-only CAS content-blob reader for query-only projection sessions
 * (works for standard workspaces, custom localRoot layouts, and edge replica generations).
 */
export function resolveContentBlobReader(projectionPath: string, rootDir?: string): EventStreamPort["readContentBlob"] {
  const localRoots: string[] = [];
  const addLocalRoot = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!localRoots.includes(resolved)) localRoots.push(resolved);
  };
  if (projectionPath) addLocalRoot(path.resolve(path.dirname(projectionPath), ".."));
  if (rootDir) addLocalRoot(resolveHarnessLayout(rootDir).localRoot);
  const objectRoots = localRoots.flatMap((localRoot) =>
    ["3", "2", "1"].map((generation) => path.join(localRoot, "store", "generations", generation, "objects", "sha256")),
  );
  return (sha256: string): Uint8Array | null => {
    for (const objectRoot of objectRoots) {
      const bytes = readContentObject(objectRoot, sha256);
      if (bytes !== null) return bytes;
    }
    return null;
  };
}

export interface BatchContentReader {
  readonly prefetchBytes: (digests: ReadonlySet<string>) => ReadonlyMap<string, Uint8Array | null>;
  readonly prefetchSizes: (digests: ReadonlySet<string>) => ReadonlyMap<string, number | null>;
}

const batchContentReaders = new WeakMap<EventContentPrefetch, BatchContentReader>();

export function registerBatchContentReader(prefetch: EventContentPrefetch, reader: BatchContentReader): void {
  batchContentReaders.set(prefetch, reader);
}

export function batchContentReaderFor(prefetch: EventContentPrefetch | undefined): BatchContentReader | undefined {
  return prefetch === undefined ? undefined : batchContentReaders.get(prefetch);
}

function isInterpretedDecisionPath(documentPath: string, policyId?: string): boolean {
  return policyId === DECISION_DOCUMENT_POLICY_ID || decisionDocumentPattern.test(documentPath);
}

/**
 * Partition content claims in a replay batch into:
 * - `interpretedDigests`: blobs whose UTF-8/JSON/YAML/Decision prose bytes are parsed or indexed during replay;
 * - `sizeOnlyDigests`: non-interpreted document blobs (e.g. `tasks/star/artifacts/star`, lifecycle docs, facts)
 *   that only require CAS existence and byte-length verification during projection replay.
 */
export function partitionBatchContentClaims(events: readonly PersistedCanonicalEventV1[]): {
  readonly interpretedDigests: ReadonlySet<string>;
  readonly sizeOnlyDigests: ReadonlySet<string>;
} {
  const interpreted = new Set<string>();
  const all = new Set<string>();
  const addInterpreted = (sha256: string | undefined) => {
    if (typeof sha256 === "string" && sha256.length > 0) interpreted.add(sha256);
  };
  for (const rawEvent of events) {
    const event = normalizeHistoricalEvent(rawEvent);
    if (isRetiredCiRunObservationEvent(event)) continue;
    if (
      !canonicalEventSchemas.some((candidate) => candidate.schema === event.schema) ||
      isUnknownForwardCanonicalEventType(event)
    )
      continue;
    for (const claim of contentClaims(event)) all.add(claim.sha256);
    if (isTaskBootstrapEvent(event)) {
      addInterpreted(event.payload.presetSnapshotClaim?.sha256);
      continue;
    }
    if (isPresetSnapshotUpgradeEvent(event)) {
      addInterpreted(event.payload.presetSnapshotClaim?.sha256);
      continue;
    }
    if (isEntityEvent(event) && isEntityDeclarationEvent(event) && event.type !== "entity_reference_declared") {
      addInterpreted(event.payload.declarationDocumentClaim?.sha256);
      for (const owned of entityOwnedDocumentClaims(ownedContentForDeclarationEvent(event))) {
        if (isInterpretedDecisionPath(owned.path, owned.policyId)) addInterpreted(owned.sha256);
      }
      continue;
    }
    if (isScheduleEvent(event)) {
      if ("declarationDocumentClaim" in event.payload) addInterpreted(event.payload.declarationDocumentClaim?.sha256);
      continue;
    }
    if (isSettingsEvent(event)) {
      addInterpreted(event.payload.harnessDocumentClaim?.sha256);
      continue;
    }
    if (isVerticalDeclarationEvent(event)) {
      addInterpreted(event.payload.declarationDocumentClaim?.sha256);
      continue;
    }
    if (isRetiredPeopleEvent(event)) {
      addInterpreted(event.payload.peopleDocumentClaim?.sha256);
      continue;
    }
    if (isDecisionEvent(event)) {
      addInterpreted(event.payload.decisionDocumentClaim?.sha256);
      if (event.type === "decision_review_recorded") {
        for (const change of event.payload.carriedDocumentClaims ?? []) {
          if (isInterpretedDecisionPath(change.path, change.policyId)) addInterpreted(change.candidate?.sha256);
        }
      }
      continue;
    }
    if (isMigrationImportEvent(event)) {
      if (event.payload.entity.kind === "decision") addInterpreted(event.payload.entity.documentClaim?.sha256);
      continue;
    }
    if (isDocEvent(event)) {
      for (const change of event.payload.changes) {
        if (change.candidate !== null && isInterpretedDecisionPath(change.path, change.policyId))
          addInterpreted(change.candidate.sha256);
      }
      continue;
    }
    if (isTaskEvent(event)) {
      for (const change of event.payload.carriedDocumentClaims ?? []) {
        if (isInterpretedDecisionPath(change.path, change.policyId)) addInterpreted(change.candidate?.sha256);
      }
      continue;
    }
    if (isTaskProgressEvent(event)) {
      for (const change of event.payload.carriedDocumentClaims ?? []) {
        if (isInterpretedDecisionPath(change.path, change.policyId)) addInterpreted(change.candidate?.sha256);
      }
      continue;
    }
    if (isEntityDocumentEvent(event) || isDossierSynthesisEvent(event)) {
      for (const claim of event.payload.documentClaims) {
        if (isInterpretedDecisionPath(claim.path, claim.policyId)) addInterpreted(claim.sha256);
      }
      continue;
    }
    if (isRelationEvent(event)) {
      for (const claim of event.payload.documentClaims ?? []) {
        if (isInterpretedDecisionPath(claim.path, claim.policyId)) addInterpreted(claim.sha256);
      }
      continue;
    }
  }
  const sizeOnly = new Set<string>();
  for (const digest of all) if (!interpreted.has(digest)) sizeOnly.add(digest);
  return { interpretedDigests: interpreted, sizeOnlyDigests: sizeOnly };
}
