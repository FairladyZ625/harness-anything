import { readFileSync } from "node:fs";
import path from "node:path";
import {
  executeKbMount,
  executeKbPut,
  settleHostLocalReceipt,
  type KbMountRequest,
} from "@harness-anything/application/commands";
import { readKbCatalog, readKbDocument, readKbOutline } from "@harness-anything/application/queries";
import {
  readDaemonRegistry,
  sha256Text,
  stableStringify,
  type WriteReceipt,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type {
  KbAssetWriteInput,
  KbDocumentRelation,
  KbDocumentStatus,
  KbMountMode,
  KbQueryScope,
  KbScope,
} from "@harness-anything/kernel/internal/domain/kb-document-bundle.ts";
import { createLocalKbStorePort } from "./local-kb-store.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";

const KB_ACTION_KINDS = new Set(["kb-catalog", "kb-outline", "kb-read", "kb-put", "kb-mount"]);

export function isKbAction(kind: string): boolean {
  return KB_ACTION_KINDS.has(kind);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((s) => s.trim());
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolvePutMarkdown(
  rootDir: string,
  action: RepoTaskAction,
  executionRestricted: boolean,
  codedError: (code: string, message: string) => Error,
): string {
  const hasInline = typeof action.content === "string";
  const hasFile = typeof action.contentFile === "string" && action.contentFile.trim().length > 0;
  if (hasInline && hasFile) {
    throw codedError("invalid_field", "Use only one of --content or --file.");
  }
  if (hasInline) return action.content as string;
  if (hasFile) {
    const resolved = path.resolve(rootDir, String(action.contentFile));
    if (executionRestricted) {
      const normalizedRoot = path.resolve(rootDir);
      const cmpRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
      const cmpResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const prefix = cmpRoot.endsWith(path.sep) ? cmpRoot : `${cmpRoot}${path.sep}`;
      if (cmpResolved !== cmpRoot && !cmpResolved.startsWith(prefix)) {
        throw codedError(
          "execution_credential_rejected",
          "KB source files must stay inside the dispatched repository.",
        );
      }
    }
    return readFileSync(resolved, "utf8");
  }
  throw codedError("missing_field", "Provide Markdown content with --content or --file.");
}

function parsePutAssets(value: unknown): readonly KbAssetWriteInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assets: KbAssetWriteInput[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.mediaType !== "string" || typeof record.base64 !== "string")
      continue;
    assets.push({
      path: record.path,
      mediaType: record.mediaType,
      body: new Uint8Array(Buffer.from(record.base64, "base64")),
      ...(typeof record.page === "number" ? { page: record.page } : {}),
    });
  }
  return assets;
}

function parseMountRequest(
  action: RepoTaskAction,
  codedError: (code: string, message: string) => Error,
): KbMountRequest {
  const operation = optionalString(action.operation) ?? "list";
  if (operation === "list") return { operation: "list" };
  if (operation === "add") {
    const mountId = optionalString(action.mountId);
    const rootPath = optionalString(action.rootPath);
    const mode = (optionalString(action.mode) ?? "readonly") as KbMountMode;
    if (!mountId || !rootPath) {
      throw codedError("missing_field", "kb mount add requires --mount-id and --path.");
    }
    return {
      operation: "add",
      mountId,
      rootPath,
      mode,
      ...(optionalString(action.domain) ? { domain: optionalString(action.domain)! } : {}),
      ...(optionalStringArray(action.tags) ? { tags: optionalStringArray(action.tags)! } : {}),
    };
  }
  if (operation === "remove") {
    const mountId = optionalString(action.mountId);
    if (!mountId) throw codedError("missing_field", "kb mount remove requires --mount-id.");
    return { operation: "remove", mountId };
  }
  if (operation === "write") {
    const mountId = optionalString(action.mountId);
    const relativePath = optionalString(action.relativePath);
    if (!mountId || !relativePath || typeof action.content !== "string") {
      throw codedError("missing_field", "kb mount write requires --mount-id, --relative-path, and --content.");
    }
    return {
      operation: "write",
      mountId,
      relativePath,
      markdown: action.content,
    };
  }
  throw codedError("invalid_field", `Unsupported kb-mount operation "${operation}". Use list, add, remove, or write.`);
}

function hostLocalReceipt(
  opId: string,
  revision: number,
  payload: Readonly<Record<string, unknown>>,
): WriteReceiptDraft {
  return {
    outcome: "applied",
    opId,
    revision,
    evidence: JSON.stringify(payload),
    proof: {
      committedRevision: 0,
      appliedCut: 0,
      durable: true,
      canonicalVisible: false,
      worktreeVisible: null,
    },
  };
}

export function runKbAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceiptDraft {
  const userRoot = cell.input.userRoot ?? cell.input.runtimeDaemonRoute?.userRoot;
  const localStore =
    typeof userRoot === "string" && userRoot.length > 0
      ? createLocalKbStorePort(userRoot, cell.input.repoId)
      : undefined;

  if (action.kind === "kb-catalog") {
    const result = readKbCatalog(
      {
        projection: cell.projection,
        readContentBlob: (sha256) => cell.store.readContentBlob(sha256),
        localStore,
      },
      {
        ...(optionalString(action.scope) ? { scope: optionalString(action.scope) as KbQueryScope } : {}),
        ...(optionalString(action.domain) ? { domain: optionalString(action.domain)! } : {}),
        ...(optionalString(action.tag) ? { tag: optionalString(action.tag)! } : {}),
        includeArchived: action.includeArchived === true,
        ...(optionalNumber(action.limit) === undefined ? {} : { limit: optionalNumber(action.limit)! }),
        ...(optionalString(action.cursor) ? { cursor: optionalString(action.cursor)! } : {}),
        ...(optionalNumber(action.maxSummaryChars) === undefined
          ? {}
          : { maxSummaryChars: optionalNumber(action.maxSummaryChars)! }),
      },
    );
    return cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, result.sourceRevision),
      result,
      result.sourceRevision,
      null,
    );
  }

  if (action.kind === "kb-outline") {
    const docId = cell.requiredCellText(action.docId, "docId");
    const result = readKbOutline(
      { projection: cell.projection, localStore },
      {
        docId,
        ...(optionalString(action.scope) ? { scope: optionalString(action.scope) as KbQueryScope } : {}),
      },
    );
    const revision = cell.projection.readCut().sourceRevision;
    return cell.readResult(cell.operationId(action, binding, cell.input.repoId, revision), result, revision, null);
  }

  if (action.kind === "kb-read") {
    const docId = cell.requiredCellText(action.docId, "docId");
    const result = readKbDocument(
      {
        projection: cell.projection,
        readContentBlob: (sha256) => cell.store.readContentBlob(sha256),
        localStore,
      },
      {
        docId,
        ...(optionalString(action.scope) ? { scope: optionalString(action.scope) as KbQueryScope } : {}),
        ...(optionalString(action.section) ? { section: optionalString(action.section)! } : {}),
        ...(typeof action.lines === "string" ? { lines: action.lines } : {}),
        ...(action.full === true ? { full: true } : {}),
      },
    );
    const revision = cell.projection.readCut().sourceRevision;
    return cell.readResult(cell.operationId(action, binding, cell.input.repoId, revision), result, revision, null);
  }

  if (action.kind === "kb-mount") {
    if (!localStore) {
      throw cell.cellCodedError("repo_unavailable", "Local KB store is unavailable without a daemon userRoot.");
    }
    const request = parseMountRequest(action, cell.cellCodedError);
    const result = executeKbMount(localStore, request, cell.now());
    const opId = cell.operationId(action, binding, cell.input.repoId, 0);
    return hostLocalReceipt(opId, 0, { schema: "kb-mount/v1", ...result });
  }

  // kb-put
  const scope = (optionalString(action.scope) ?? "local") as KbScope;
  const docId = cell.requiredCellText(action.docId, "docId");
  const title = cell.requiredCellText(action.title, "title");
  const domain = optionalString(action.domain) ?? "general";
  const viewMarkdown = resolvePutMarkdown(
    cell.rootDir,
    action,
    binding.executionPrincipal !== undefined,
    cell.cellCodedError,
  );
  const sourceBytes =
    typeof action.sourceBytesBase64 === "string"
      ? new Uint8Array(Buffer.from(action.sourceBytesBase64, "base64"))
      : undefined;
  const putRequest = {
    docId,
    scope,
    title,
    domain,
    summary: typeof action.summary === "string" ? action.summary : "",
    aliases: optionalStringArray(action.aliases) ?? [],
    tags: optionalStringArray(action.tags) ?? [],
    ...(optionalString(action.status) ? { status: optionalString(action.status) as KbDocumentStatus } : {}),
    ...(action.supersededBy === null || typeof action.supersededBy === "string"
      ? { supersededBy: action.supersededBy }
      : {}),
    ...(action.validFrom === null || typeof action.validFrom === "string" ? { validFrom: action.validFrom } : {}),
    ...(action.validTo === null || typeof action.validTo === "string" ? { validTo: action.validTo } : {}),
    ...(Array.isArray(action.relations) ? { relations: action.relations as readonly KbDocumentRelation[] } : {}),
    viewMarkdown,
    ...(optionalString(action.sourceFilename) ? { sourceFilename: optionalString(action.sourceFilename)! } : {}),
    ...(optionalString(action.sourceMediaType) ? { sourceMediaType: optionalString(action.sourceMediaType)! } : {}),
    ...(sourceBytes === undefined ? {} : { sourceBytes }),
    ...(parsePutAssets(action.assets) === undefined ? {} : { assets: parsePutAssets(action.assets)! }),
    ...(optionalNumber(action.expectedVersion) === undefined
      ? {}
      : { expectedVersion: optionalNumber(action.expectedVersion)! }),
  };

  if (scope === "local") {
    if (!localStore) {
      throw cell.cellCodedError("repo_unavailable", "Local KB store is unavailable without a daemon userRoot.");
    }
    const result = executeKbPut({ localStore, now: cell.now() }, putRequest);
    const opId = cell.operationId(action, binding, cell.input.repoId, result.bundle.revision);
    return hostLocalReceipt(opId, result.bundle.revision, {
      schema: "kb-put/v1",
      scope: "local",
      bundle: result.bundle,
    });
  }

  // center-shared write: enforce pre-authorized contributor RBAC & single-writer CAS.
  if (binding.authorizationDecision?.outcome !== "allowed") {
    throw cell.cellCodedError("authorization_denied", "Shared KB writes require repository contributor authority.");
  }
  const opId = cell.operationId(
    action,
    binding,
    cell.input.repoId,
    Number(action.expectedVersion ?? cell.store.readHead()?.revision ?? 0),
  );
  const result = executeKbPut(
    {
      store: cell.store,
      projection: cell.projection,
      actor: binding.actor,
      source: binding.source,
      opId,
      now: cell.now(),
    },
    putRequest,
  );
  const receipt = cell.receiptForOperation(opId, binding);
  return {
    ...receipt,
    evidence: JSON.stringify({
      schema: "kb-put/v1",
      scope: "shared",
      bundle: result.bundle,
      workspaceRevision: result.kind === "shared" ? result.workspaceRevision : 0,
      idempotentReplay: result.kind === "shared" ? result.idempotentReplay : false,
    }),
  };
}

/**
 * Edge-side intercept for `local-private` KB puts and external directory mounts on `remote-edge`.
 * Guarantees 0 forwarding to Center, 0 writes to CanonicalEventStore, and 0 Fleet replication traffic.
 */
export async function runEdgeLocalKbAction(input: {
  readonly userRoot: string | undefined;
  readonly repoId: string;
  readonly action: RepoTaskAction;
  readonly auth: { readonly transportKind: string; readonly nodePrincipal?: unknown };
  readonly now: () => string;
  readonly codedError: (code: string, message: string) => Error;
}): Promise<WriteReceiptDraft | null> {
  const { userRoot, repoId, action, auth } = input;
  if (action.kind !== "kb-mount" && action.kind !== "kb-put") return null;
  if (action.kind === "kb-put" && (optionalString(action.scope) ?? "local") !== "local") return null;
  if (auth.transportKind !== "unix-socket" || auth.nodePrincipal || typeof userRoot !== "string" || !userRoot) {
    return null;
  }
  const edgeEntry = readDaemonRegistry({ userRoot }).repos.find(
    (entry) => entry.repoId === repoId && entry.mode === "remote-edge" && entry.state === "enabled",
  );
  if (!edgeEntry?.canonicalRoot) return null;

  const localStore = createLocalKbStorePort(userRoot, repoId);
  const opId = `op_${sha256Text(stableStringify({ repoId, kind: action.kind, action, at: input.now() })).slice(0, 48)}`;

  if (action.kind === "kb-mount") {
    const request = parseMountRequest(action, input.codedError);
    const result = executeKbMount(localStore, request, input.now());
    return settleHostLocalReceipt(
      action,
      hostLocalReceipt(opId, 0, { schema: "kb-mount/v1", ...result }) as WriteReceipt,
    );
  }

  const docId = optionalString(action.docId);
  const title = optionalString(action.title);
  if (!docId || !title) {
    throw input.codedError("missing_field", "kb put requires <doc-id> and --title.");
  }
  const viewMarkdown = resolvePutMarkdown(edgeEntry.canonicalRoot, action, false, input.codedError);
  const sourceBytes =
    typeof action.sourceBytesBase64 === "string"
      ? new Uint8Array(Buffer.from(action.sourceBytesBase64, "base64"))
      : undefined;
  const result = executeKbPut(
    { localStore, now: input.now() },
    {
      docId,
      scope: "local",
      title,
      domain: optionalString(action.domain) ?? "general",
      summary: typeof action.summary === "string" ? action.summary : "",
      aliases: optionalStringArray(action.aliases) ?? [],
      tags: optionalStringArray(action.tags) ?? [],
      ...(optionalString(action.status) ? { status: optionalString(action.status) as KbDocumentStatus } : {}),
      ...(action.supersededBy === null || typeof action.supersededBy === "string"
        ? { supersededBy: action.supersededBy }
        : {}),
      ...(action.validFrom === null || typeof action.validFrom === "string" ? { validFrom: action.validFrom } : {}),
      ...(action.validTo === null || typeof action.validTo === "string" ? { validTo: action.validTo } : {}),
      ...(Array.isArray(action.relations) ? { relations: action.relations as readonly KbDocumentRelation[] } : {}),
      viewMarkdown,
      ...(optionalString(action.sourceFilename) ? { sourceFilename: optionalString(action.sourceFilename)! } : {}),
      ...(optionalString(action.sourceMediaType) ? { sourceMediaType: optionalString(action.sourceMediaType)! } : {}),
      ...(sourceBytes === undefined ? {} : { sourceBytes }),
      ...(parsePutAssets(action.assets) === undefined ? {} : { assets: parsePutAssets(action.assets)! }),
      ...(optionalNumber(action.expectedVersion) === undefined
        ? {}
        : { expectedVersion: optionalNumber(action.expectedVersion)! }),
    },
  );
  return settleHostLocalReceipt(
    action,
    hostLocalReceipt(opId, result.bundle.revision, {
      schema: "kb-put/v1",
      scope: "local",
      bundle: result.bundle,
    }) as WriteReceipt,
  );
}
