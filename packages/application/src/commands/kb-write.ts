import {
  isValidKbDocId,
  kbDocumentStatuses,
  kbScopes,
  type KbAssetWriteInput,
  type KbDocumentBundleV1,
  type KbDocumentRelation,
  type KbDocumentStatus,
  type KbMountDeclarationV1,
  type KbMountMode,
  type KbScope,
  type LocalKbStorePort,
} from "@harness-anything/kernel/internal/domain/kb-document-bundle.ts";
import {
  compileKbDocumentUpserted,
  isKbDocumentEvent,
  reduceKbDocumentEvent,
  type KbDocumentEventV1,
  type KbDocumentRecord,
} from "@harness-anything/kernel/internal/domain/kb-document-event.ts";
import type { ActorIdentity, CanonicalEventStore, TaskProjection, WriteSource } from "@harness-anything/kernel";

export class KbCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KbCommandError";
    this.code = code;
  }
}

export interface KbPutRequest {
  readonly docId: string;
  readonly scope?: KbScope;
  readonly title: string;
  readonly summary?: string;
  readonly domain: string;
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
  readonly status?: KbDocumentStatus;
  readonly supersededBy?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly relations?: readonly KbDocumentRelation[];
  readonly viewMarkdown: string;
  readonly sourceFilename?: string;
  readonly sourceMediaType?: string;
  readonly sourceBytes?: Uint8Array;
  readonly assets?: readonly KbAssetWriteInput[];
  readonly expectedVersion?: number;
}

export interface KbPutPorts {
  readonly localStore?: LocalKbStorePort;
  readonly store?: Pick<CanonicalEventStore, "readHead" | "readEvent" | "append">;
  readonly projection?: Pick<TaskProjection, "readKbDocuments" | "apply">;
  readonly actor?: ActorIdentity;
  readonly source?: WriteSource;
  readonly opId?: string;
  readonly now: string;
}

export type KbPutResult =
  | {
      readonly kind: "local";
      readonly bundle: KbDocumentBundleV1;
    }
  | {
      readonly kind: "shared";
      readonly bundle: KbDocumentRecord;
      readonly event: KbDocumentEventV1;
      readonly workspaceRevision: number;
      readonly idempotentReplay: boolean;
    };

export type KbMountRequest =
  | { readonly operation: "list" }
  | {
      readonly operation: "add";
      readonly mountId: string;
      readonly rootPath: string;
      readonly mode: KbMountMode;
      readonly domain?: string;
      readonly tags?: readonly string[];
    }
  | { readonly operation: "remove"; readonly mountId: string }
  | {
      readonly operation: "write";
      readonly mountId: string;
      readonly relativePath: string;
      readonly markdown: string;
    };

export type KbMountResult =
  | { readonly operation: "list"; readonly mounts: readonly KbMountDeclarationV1[] }
  | { readonly operation: "add"; readonly mount: KbMountDeclarationV1 }
  | { readonly operation: "remove"; readonly mountId: string; readonly removed: boolean }
  | { readonly operation: "write"; readonly bundle: KbDocumentBundleV1 };

export function executeKbPut(ports: KbPutPorts, request: KbPutRequest): KbPutResult {
  const scope: KbScope = request.scope ?? "local";
  if (!(kbScopes as readonly string[]).includes(scope)) {
    throw new KbCommandError("invalid_field", `KB scope must be "local" or "shared".`);
  }
  if (!isValidKbDocId(request.docId)) {
    throw new KbCommandError("invalid_field", `Invalid KB docId "${request.docId}". Expected doc_<id>.`);
  }
  const title = request.title.trim();
  if (!title) {
    throw new KbCommandError("invalid_field", "KB document title must be non-empty.");
  }
  const domain = request.domain.trim();
  if (!domain) {
    throw new KbCommandError("invalid_field", "KB document domain must be non-empty.");
  }
  const status: KbDocumentStatus = request.status ?? "active";
  if (!(kbDocumentStatuses as readonly string[]).includes(status)) {
    throw new KbCommandError("invalid_field", `KB status must be one of: ${kbDocumentStatuses.join(", ")}.`);
  }
  if (
    request.expectedVersion !== undefined &&
    (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0)
  ) {
    throw new KbCommandError("invalid_field", "expectedVersion must be a non-negative integer.");
  }

  const manifestInput = {
    title,
    aliases: [...(request.aliases ?? [])],
    summary: request.summary ?? "",
    domain,
    tags: [...(request.tags ?? [])],
    status,
    ...(request.supersededBy === undefined ? {} : { supersededBy: request.supersededBy }),
    ...(request.validFrom === undefined ? {} : { validFrom: request.validFrom }),
    ...(request.validTo === undefined ? {} : { validTo: request.validTo }),
    relations: [...(request.relations ?? [])],
  };

  if (scope === "local") {
    if (!ports.localStore) {
      throw new KbCommandError("repo_unavailable", "Local KB store is unavailable on this host.");
    }
    const bundle = ports.localStore.putBundle({
      docId: request.docId,
      manifest: manifestInput,
      viewMarkdown: request.viewMarkdown,
      ...(request.sourceFilename === undefined ? {} : { sourceFilename: request.sourceFilename }),
      ...(request.sourceMediaType === undefined ? {} : { sourceMediaType: request.sourceMediaType }),
      ...(request.sourceBytes === undefined ? {} : { sourceBytes: request.sourceBytes }),
      ...(request.assets === undefined ? {} : { assets: request.assets }),
      ...(request.expectedVersion === undefined ? {} : { expectedVersion: request.expectedVersion }),
      now: ports.now,
    });
    return { kind: "local", bundle };
  }

  if (!ports.store || !ports.projection || !ports.actor || !ports.source || !ports.opId) {
    throw new KbCommandError("repo_unavailable", "Shared KB canonical write ports are unavailable.");
  }

  const existingOp = ports.store.readEvent(ports.opId);
  if (existingOp) {
    if (!isKbDocumentEvent(existingOp)) {
      throw new KbCommandError("invalid_store", `Operation id ${ports.opId} already belongs to another event.`);
    }
    const existingRecord = ports.projection.readKbDocuments({ by: "id", docId: existingOp.payload.docId });
    const record =
      existingRecord.status === "ready" && existingRecord.records[0]
        ? existingRecord.records[0]
        : reduceKbDocumentEvent(null, existingOp);
    return {
      kind: "shared",
      bundle: record,
      event: existingOp,
      workspaceRevision: existingOp.workspaceRevision,
      idempotentReplay: true,
    };
  }

  const currentRead = ports.projection.readKbDocuments({ by: "id", docId: request.docId });
  if (currentRead.status !== "ready") {
    throw new KbCommandError(
      "projection_pending",
      `Shared KB projection is catching up (${currentRead.watermark}/${currentRead.sourceRevision}).`,
    );
  }
  const current = currentRead.records[0] ?? null;
  const currentRevision = current?.revision ?? 0;
  if (request.expectedVersion !== undefined && request.expectedVersion !== currentRevision) {
    throw new KbCommandError(
      "revision_conflict",
      `Shared KB document ${request.docId} expected revision ${request.expectedVersion}, current revision is ${currentRevision}.`,
    );
  }

  const headRevision = ports.store.readHead()?.revision ?? 0;
  const compiled = compileKbDocumentUpserted({
    eventId: `event-${ports.opId}`,
    opId: ports.opId,
    workspaceRevision: headRevision + 1,
    actor: ports.actor,
    source: ports.source,
    occurredAt: ports.now,
    docId: request.docId,
    documentRevision: currentRevision + 1,
    manifest: manifestInput,
    viewMarkdown: request.viewMarkdown,
    ...(request.sourceFilename === undefined ? {} : { sourceFilename: request.sourceFilename }),
    ...(request.sourceMediaType === undefined ? {} : { sourceMediaType: request.sourceMediaType }),
    ...(request.sourceBytes === undefined ? {} : { sourceBytes: request.sourceBytes }),
    ...(request.assets === undefined ? {} : { assets: request.assets }),
  });

  ports.store.append(compiled);
  ports.projection.apply(compiled.event, compiled.plan);
  const record = reduceKbDocumentEvent(current, compiled.event);
  return {
    kind: "shared",
    bundle: record,
    event: compiled.event,
    workspaceRevision: compiled.event.workspaceRevision,
    idempotentReplay: false,
  };
}

export function executeKbMount(localStore: LocalKbStorePort, request: KbMountRequest, now: string): KbMountResult {
  if (request.operation === "list") {
    return { operation: "list", mounts: localStore.listMounts() };
  }
  if (request.operation === "add") {
    const mount = localStore.addMount({
      mountId: request.mountId,
      rootPath: request.rootPath,
      mode: request.mode,
      ...(request.domain === undefined ? {} : { domain: request.domain }),
      ...(request.tags === undefined ? {} : { tags: request.tags }),
      now,
    });
    return { operation: "add", mount };
  }
  if (request.operation === "remove") {
    const removed = localStore.removeMount(request.mountId);
    return { operation: "remove", mountId: request.mountId, removed };
  }
  if (!localStore.writeMountedMarkdown) {
    throw new KbCommandError("repo_unavailable", "Local KB mount writer is unavailable.");
  }
  const bundle = localStore.writeMountedMarkdown({
    mountId: request.mountId,
    relativePath: request.relativePath,
    markdown: request.markdown,
  });
  return { operation: "write", bundle };
}
