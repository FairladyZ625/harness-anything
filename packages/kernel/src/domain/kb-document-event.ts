import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { sha256Bytes, sha256Text } from "../integrity/stable-hash.ts";
import {
  KB_CATALOG_DEFAULT_LIMIT,
  KB_CATALOG_MAX_LIMIT,
  KB_DOCUMENT_BUNDLE_SCHEMA,
  countMarkdownLines,
  isValidKbDocId,
  parseMarkdownOutline,
  validateKbAssetRefV1,
  validateKbDocumentManifestV1,
  validateKbSourceRefV1,
  validateKbViewRefV1,
  type KbAssetWriteInput,
  type KbDocumentAssetRefV1,
  type KbDocumentBundleV1,
  type KbDocumentManifestV1,
  type KbDocumentSourceRefV1,
  type KbDocumentViewRefV1,
  type KbOutlineHeading,
} from "./kb-document-bundle.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
} from "./write-chain.contract.ts";

export const KB_DOCUMENT_EVENT_SCHEMA = "kb-document-event/v1";
export const KB_DOCUMENT_MODEL_VERSION = 1;
export const kbDocumentEventTypes = Object.freeze(["kb_document_upserted"] as const);
export type KbDocumentEventType = (typeof kbDocumentEventTypes)[number];

export interface KbDocumentUpsertedPayload {
  readonly docId: string;
  readonly documentRevision: number;
  readonly manifest: KbDocumentManifestV1;
  readonly source: KbDocumentSourceRefV1;
  readonly view: KbDocumentViewRefV1;
  readonly assets: readonly KbDocumentAssetRefV1[];
}

export type KbDocumentEventV1 = EventEnvelope<
  typeof KB_DOCUMENT_EVENT_SCHEMA,
  "kb_document_upserted",
  ActorIdentity,
  KbDocumentUpsertedPayload
>;

export interface KbDocumentRecord extends KbDocumentBundleV1 {
  readonly scope: "shared";
  readonly workspaceRevision: number;
  readonly createdAt: string;
}

export type KbDocumentQuery =
  | { readonly by: "id"; readonly docId: string }
  | {
      readonly by: "list";
      readonly domain?: string;
      readonly tag?: string;
      readonly includeArchived?: boolean;
      readonly limit?: number;
      readonly cursor?: string;
    };

export type KbDocumentRead =
  | {
      readonly status: "pending";
      readonly watermark: number;
      readonly sourceRevision: number;
    }
  | {
      readonly status: "ready";
      readonly watermark: number;
      readonly sourceRevision: number;
      readonly records: readonly KbDocumentRecord[];
      readonly nextCursor: string | null;
    };

export interface KbDocumentContentBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly body: string | Uint8Array;
}

export interface KbDocumentUpsertBundle {
  readonly event: KbDocumentEventV1;
  readonly plan: FrozenWritePlan<"KbDocumentUpsert">;
  readonly blobs: readonly KbDocumentContentBlob[];
}

export function isKbDocumentEventType(value: unknown): value is KbDocumentEventType {
  return typeof value === "string" && (kbDocumentEventTypes as readonly string[]).includes(value);
}

export function isKbDocumentEvent(event: {
  readonly schema: string;
  readonly type?: string;
}): event is KbDocumentEventV1 {
  return event.schema === KB_DOCUMENT_EVENT_SCHEMA && isKbDocumentEventType(event.type);
}

export function validateKbDocumentEvent(value: unknown): readonly string[] {
  return validateKbDocumentEventFields(value, true);
}

export function validateCurrentKbDocumentEvent(value: unknown): readonly string[] {
  return validateKbDocumentEventFields(value, false);
}

function validateKbDocumentEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  const envelopeFields = [
    "schema",
    "eventId",
    "workspaceRevision",
    "opId",
    "type",
    "actor",
    "source",
    "occurredAt",
    "payload",
  ];
  if (
    !isRecord(value) ||
    !hasFields(value, envelopeFields) ||
    value.schema !== KB_DOCUMENT_EVENT_SCHEMA ||
    !isKbDocumentEventType(value.type) ||
    !isRecord(value.payload)
  )
    return ["kb document event envelope or payload is invalid"];
  const identityErrors = validateEventEnvelopeIdentity(value, allowUnknownFields);
  if (identityErrors.length) return identityErrors;

  const payload = value.payload;
  const payloadFields = ["docId", "documentRevision", "manifest", "source", "view", "assets"];
  if (!hasFields(payload, payloadFields)) return ["kb_document_upserted payload fields are invalid"];

  const issues: string[] = [];
  if (!isValidKbDocId(payload.docId)) issues.push("kb event docId must match doc_<id>");
  if (!Number.isSafeInteger(payload.documentRevision) || Number(payload.documentRevision) < 1)
    issues.push("kb event documentRevision must be a positive safe integer");
  issues.push(...validateKbDocumentManifestV1(payload.manifest, allowUnknownFields));
  issues.push(...validateKbSourceRefV1(payload.source, allowUnknownFields));
  issues.push(...validateKbViewRefV1(payload.view, allowUnknownFields));
  if (!Array.isArray(payload.assets)) issues.push("kb event assets must be an array");
  else for (const asset of payload.assets) issues.push(...validateKbAssetRefV1(asset, allowUnknownFields));
  return issues;
}

export function kbDocumentEventContentClaims(event: KbDocumentEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  const claims = [
    {
      sha256: event.payload.source.sha256,
      size: event.payload.source.byteLength,
      mediaType: event.payload.source.mediaType,
    },
    { sha256: event.payload.view.sha256, size: event.payload.view.byteLength, mediaType: event.payload.view.mediaType },
    ...event.payload.assets.map((asset) => ({
      sha256: asset.sha256,
      size: asset.byteLength,
      mediaType: asset.mediaType,
    })),
  ];
  return [...new Map(claims.map((claim) => [claim.sha256, claim])).values()];
}

export function kbDocumentWritePlan(event: KbDocumentEventV1): FrozenWritePlan<"KbDocumentUpsert"> {
  const claims = kbDocumentEventContentClaims(event);
  return freezeDeclaredWritePlan(
    {
      commandType: "KbDocumentUpsert",
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "kb-document/v1", key: event.payload.docId },
        ...claims.map((claim) => ({
          kind: "content_blob" as const,
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
        })),
      ],
    },
    ["KbDocumentUpsert"],
  );
}

export function compileKbDocumentUpserted(input: {
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
  readonly docId: string;
  readonly documentRevision: number;
  readonly manifest: Omit<KbDocumentManifestV1, "outline"> & { readonly outline?: readonly KbOutlineHeading[] };
  readonly viewMarkdown: string;
  readonly sourceFilename?: string;
  readonly sourceMediaType?: string;
  readonly sourceBytes?: Uint8Array;
  readonly assets?: readonly KbAssetWriteInput[];
}): KbDocumentUpsertBundle {
  const encoder = new TextEncoder();
  const viewBytes = encoder.encode(input.viewMarkdown);
  const viewSha = sha256Text(input.viewMarkdown);
  const sourceFilename = input.sourceFilename ?? "source.md";
  const sourceMediaType = input.sourceMediaType ?? "text/markdown";
  const sourceBytes = input.sourceBytes ?? viewBytes;
  const sourceSha = input.sourceBytes ? sha256Bytes(input.sourceBytes) : viewSha;

  const outline = input.manifest.outline ?? parseMarkdownOutline(input.viewMarkdown);
  const manifest: KbDocumentManifestV1 = {
    title: input.manifest.title,
    aliases: [...input.manifest.aliases],
    summary: input.manifest.summary,
    domain: input.manifest.domain,
    tags: [...input.manifest.tags],
    status: input.manifest.status,
    ...(input.manifest.supersededBy === undefined ? {} : { supersededBy: input.manifest.supersededBy }),
    ...(input.manifest.validFrom === undefined ? {} : { validFrom: input.manifest.validFrom }),
    ...(input.manifest.validTo === undefined ? {} : { validTo: input.manifest.validTo }),
    relations: [...input.manifest.relations],
    outline: [...outline],
  };

  const sourceRef: KbDocumentSourceRefV1 = {
    filename: sourceFilename,
    mediaType: sourceMediaType,
    sha256: sourceSha,
    byteLength: sourceBytes.byteLength,
  };
  const viewRef: KbDocumentViewRefV1 = {
    filename: "view.md",
    mediaType: "text/markdown",
    sha256: viewSha,
    byteLength: viewBytes.byteLength,
    lineCount: countMarkdownLines(input.viewMarkdown),
  };

  const assetRefs: KbDocumentAssetRefV1[] = [];
  const blobsBySha = new Map<string, KbDocumentContentBlob>();
  blobsBySha.set(sourceSha, {
    sha256: sourceSha,
    size: sourceBytes.byteLength,
    mediaType: sourceMediaType,
    body: input.sourceBytes ? sourceBytes : input.viewMarkdown,
  });
  if (!blobsBySha.has(viewSha)) {
    blobsBySha.set(viewSha, {
      sha256: viewSha,
      size: viewBytes.byteLength,
      mediaType: "text/markdown",
      body: input.viewMarkdown,
    });
  }
  for (const asset of input.assets ?? []) {
    const assetSha = sha256Bytes(asset.body);
    assetRefs.push({
      path: asset.path,
      mediaType: asset.mediaType,
      sha256: assetSha,
      byteLength: asset.body.byteLength,
      ...(asset.page === undefined ? {} : { page: asset.page }),
    });
    if (!blobsBySha.has(assetSha)) {
      blobsBySha.set(assetSha, {
        sha256: assetSha,
        size: asset.body.byteLength,
        mediaType: asset.mediaType,
        body: asset.body,
      });
    }
  }

  const event: KbDocumentEventV1 = {
    schema: KB_DOCUMENT_EVENT_SCHEMA,
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "kb_document_upserted",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      docId: input.docId,
      documentRevision: input.documentRevision,
      manifest,
      source: sourceRef,
      view: viewRef,
      assets: assetRefs,
    },
  };
  const errors = validateCurrentKbDocumentEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    event,
    plan: kbDocumentWritePlan(event),
    blobs: [...blobsBySha.values()],
  };
}

export function reduceKbDocumentEvent(current: KbDocumentRecord | null, event: KbDocumentEventV1): KbDocumentRecord {
  return {
    schema: KB_DOCUMENT_BUNDLE_SCHEMA,
    docId: event.payload.docId,
    scope: "shared",
    revision: event.payload.documentRevision,
    workspaceRevision: event.workspaceRevision,
    manifest: event.payload.manifest,
    source: event.payload.source,
    view: event.payload.view,
    assets: event.payload.assets,
    createdAt: current?.createdAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

export function kbDocumentPageLimit(limit?: number): number {
  if (limit === undefined) return KB_CATALOG_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) return KB_CATALOG_DEFAULT_LIMIT;
  return Math.min(limit, KB_CATALOG_MAX_LIMIT);
}

export function kbDocumentCursor(cursor?: string): string {
  return typeof cursor === "string" ? cursor : "";
}

export function kbDocumentNextCursor(matched: readonly { readonly docId: string }[], limit: number): string | null {
  return matched.length > limit ? matched[limit - 1]!.docId : null;
}

export function matchesKbDocumentListFilter(
  record: Pick<KbDocumentBundleV1, "manifest">,
  query: { readonly domain?: string; readonly tag?: string; readonly includeArchived?: boolean },
): boolean {
  if (query.includeArchived !== true && record.manifest.status !== "active") return false;
  if (query.domain !== undefined && record.manifest.domain !== query.domain) return false;
  if (query.tag !== undefined && !record.manifest.tags.includes(query.tag)) return false;
  return true;
}

export const kbDocumentJudgments = [
  {
    id: "kb-document-bundle-validation",
    symbol: "packages/kernel/src/domain/kb-document-bundle.ts#validateKbDocumentBundleV1",
    inputs: ["unknown kb-document-bundle/v1 payload"],
    output: "readonly string[] validation issues",
    failureCodes: ["invalid_field"],
    explain: "Validate kb-document-bundle/v1 manifests, outlines, relations, source/view refs, and asset refs.",
    consumers: ["packages/kernel/src/domain/kb-document-event.ts", "packages/daemon/src/daemon-host/local-kb-store.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateOutlineEntry:22d01f1e311f3a47b21f3b45fa098e75",
        route: "validateOutlineEntry",
      },
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateRelationEntry:fedec3351554f1bee72181e228af44fb",
        route: "validateRelationEntry",
      },
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateKbDocumentManifestV1:ca726a265119a8f15b9fdf8b159ee515",
        route: "validateKbDocumentManifestV1",
      },
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateKbSourceRefV1:6f0de9cd90ae64c6237f69ec961c0b68",
        route: "validateKbSourceRefV1",
      },
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateKbViewRefV1:22128c8ece3e26dd16df3618ff80c0e7",
        route: "validateKbViewRefV1",
      },
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateKbAssetRefV1:ebbe336e5078593962756d572ca50844",
        route: "validateKbAssetRefV1",
      },
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#validateKbDocumentBundleV1:2b96258d327854a2e2e3b1a5e669b4bd",
        route: "validateKbDocumentBundleV1",
      },
    ],
  },
  {
    id: "kb-document-event-validation",
    symbol: "packages/kernel/src/domain/kb-document-event.ts#validateCurrentKbDocumentEvent",
    inputs: ["unknown kb-document-event/v1 event"],
    output: "readonly string[] validation issues",
    failureCodes: ["invalid_field"],
    explain: "Validate canonical kb-document-event/v1 envelopes and payloads before admission or replay.",
    consumers: ["packages/kernel/src/domain/doc-sync-canonical-events.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/kb-document-event.ts#validateKbDocumentEventFields:d7af7a9a117f6306edb665b382d951cb",
        route: "validateKbDocumentEventFields",
      },
    ],
  },
  {
    id: "kb-local-mount-containment",
    symbol: "packages/kernel/src/domain/kb-document-bundle.ts#tryNormalizeRelativePosixPath",
    inputs: ["mount root path and candidate relative or filesystem path"],
    output: "canonical relative POSIX path or containment error",
    failureCodes: ["kb_path_escape"],
    explain: "Enforce symlink and path-traversal containment inside host-local KB bundles and external mounts.",
    consumers: ["packages/daemon/src/daemon-host/local-kb-store.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/daemon:packages/daemon/src/daemon-host/local-kb-store.ts#assertNotSymlink:8115a20cae081ea8725bc303f660039f",
        route: "local-kb-store",
      },
      {
        candidateId:
          "judgment:packages/daemon:packages/daemon/src/daemon-host/local-kb-store.ts#isPathInsideRoot:95857113947379b838c2fdd41e5711fd",
        route: "local-kb-store",
      },
      {
        candidateId:
          "judgment:packages/daemon:packages/daemon/src/daemon-host/local-kb-store.ts#assertNoSymlinkSegments:bd676de909fedf49d2561a12aa1ced85",
        route: "local-kb-store",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

export const kbDocumentPolicies = [
  {
    id: "kb-catalog-pagination",
    ownerRef: "document",
    unit: "catalog cards per page",
    bounds: "1..100 cards per page (default 20), returning a nextCursor when additional cards remain.",
    defaultValue: KB_CATALOG_DEFAULT_LIMIT,
    version: 1,
    scope: "KB catalog pagination across local-private and center-shared scopes",
    reason: "Bounded catalog pages prevent single-response tool truncation as the knowledge base grows.",
    fixtures: [
      "packages/kernel/test/kb-document-bundle.test.ts",
      "packages/storage/test/store/kb-document-projection.test.ts",
    ],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#KB_CATALOG_DEFAULT_LIMIT:8504ff37784805ca868a35a06ae6091e",
        route: "KB_CATALOG_DEFAULT_LIMIT",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/kb-document-bundle.ts#KB_CATALOG_MAX_LIMIT:fb676d5becfe3ee4d634370953c57579",
        route: "KB_CATALOG_MAX_LIMIT",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/kb-document-event.ts#kbDocumentPageLimit:0bc96b8bf95f0378d3148801baaf0f86",
        route: "kbDocumentPageLimit",
      },
      {
        candidateId:
          "policy:packages/application:packages/application/src/queries/kb-read.ts#readKbCatalog.nextCursor:57aacbac364260f0e179e818544d8643",
        route: "readKbCatalog",
      },
    ],
  },
] as const satisfies readonly OntologyPolicyDeclaration[];
