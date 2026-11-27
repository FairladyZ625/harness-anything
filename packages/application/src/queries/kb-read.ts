import {
  KB_CATALOG_DEFAULT_LIMIT,
  KB_CATALOG_DEFAULT_SUMMARY_CHARS,
  KB_CATALOG_MAX_LIMIT,
  isValidKbDocId,
  kbCatalogCardFromBundle,
  kbQueryScopes,
  parseLineRangeSpec,
  readKbViewContent,
  type KbCatalogCardV1,
  type KbDocumentBundleV1,
  type KbOutlineHeading,
  type KbQueryScope,
  type KbScope,
  type LocalKbStorePort,
} from "@harness-anything/kernel/internal/domain/kb-document-bundle.ts";
import {
  kbDocumentPageLimit,
  matchesKbDocumentListFilter,
} from "@harness-anything/kernel/internal/domain/kb-document-event.ts";
import type { TaskProjectionQueries } from "@harness-anything/kernel";

export class KbQueryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KbQueryError";
    this.code = code;
  }
}

export interface KbReadPorts {
  readonly projection?: Pick<TaskProjectionQueries, "readCut" | "readKbDocuments">;
  readonly readContentBlob?: (sha256: string) => Uint8Array | null;
  readonly localStore?: Pick<LocalKbStorePort, "listBundles" | "getBundle" | "readView">;
}

export interface KbCatalogQueryInput {
  readonly scope?: KbQueryScope;
  readonly domain?: string;
  readonly tag?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxSummaryChars?: number;
}

export interface KbCatalogResult {
  readonly schema: "kb-catalog/v1";
  readonly scope: KbQueryScope;
  readonly includeArchived: boolean;
  readonly items: readonly KbCatalogCardV1[];
  readonly nextCursor: string | null;
  readonly watermark: number;
  readonly sourceRevision: number;
}

export interface KbOutlineQueryInput {
  readonly docId: string;
  readonly scope?: KbQueryScope;
}

export interface KbOutlineResult {
  readonly schema: "kb-outline/v1";
  readonly docId: string;
  readonly scope: KbScope;
  readonly revision: number;
  readonly title: string;
  readonly status: KbDocumentBundleV1["manifest"]["status"];
  readonly domain: string;
  readonly lineCount: number;
  readonly outline: readonly KbOutlineHeading[];
}

export interface KbDocumentReadInput {
  readonly docId: string;
  readonly scope?: KbQueryScope;
  readonly section?: string;
  readonly lines?: string | { readonly start: number; readonly end: number };
  readonly full?: boolean;
}

export interface KbDocumentReadResult {
  readonly schema: "kb-read/v1";
  readonly docId: string;
  readonly scope: KbScope;
  readonly revision: number;
  readonly title: string;
  readonly status: KbDocumentBundleV1["manifest"]["status"];
  readonly mode: "section" | "lines" | "full";
  readonly section?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly content: string;
}

function resolveQueryScope(raw: unknown): KbQueryScope {
  if (raw === undefined) return "all";
  if (typeof raw === "string" && (kbQueryScopes as readonly string[]).includes(raw)) {
    return raw as KbQueryScope;
  }
  throw new KbQueryError("invalid_field", `KB scope must be one of: ${kbQueryScopes.join(", ")}.`);
}

function catalogSortKey(bundle: Pick<KbDocumentBundleV1, "scope" | "docId">): string {
  return `${bundle.scope}:${bundle.docId}`;
}

function readAllSharedBundles(
  projection: Pick<TaskProjectionQueries, "readKbDocuments">,
  filters: { readonly domain?: string; readonly tag?: string; readonly includeArchived?: boolean },
): { readonly bundles: readonly KbDocumentBundleV1[]; readonly watermark: number; readonly sourceRevision: number } {
  const bundles: KbDocumentBundleV1[] = [];
  let cursor: string | undefined;
  let watermark: number;
  let sourceRevision: number;
  for (;;) {
    const page = projection.readKbDocuments({
      by: "list",
      ...(filters.domain === undefined ? {} : { domain: filters.domain }),
      ...(filters.tag === undefined ? {} : { tag: filters.tag }),
      includeArchived: filters.includeArchived === true,
      limit: KB_CATALOG_MAX_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.status !== "ready") {
      throw new KbQueryError(
        "projection_pending",
        `Shared KB projection is catching up (${page.watermark}/${page.sourceRevision}).`,
      );
    }
    watermark = page.watermark;
    sourceRevision = page.sourceRevision;
    bundles.push(...page.records);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { bundles, watermark, sourceRevision };
}

export function readKbCatalog(ports: KbReadPorts, input: KbCatalogQueryInput = {}): KbCatalogResult {
  const scope = resolveQueryScope(input.scope);
  const includeArchived = input.includeArchived === true;
  const limit = kbDocumentPageLimit(input.limit ?? KB_CATALOG_DEFAULT_LIMIT);
  const maxSummaryChars = input.maxSummaryChars ?? KB_CATALOG_DEFAULT_SUMMARY_CHARS;
  const cursor = typeof input.cursor === "string" ? input.cursor : "";

  const bundles: KbDocumentBundleV1[] = [];
  let watermark = 0;
  let sourceRevision = 0;

  if (scope === "local" || scope === "all") {
    const localBundles = ports.localStore?.listBundles() ?? [];
    for (const bundle of localBundles) {
      if (
        matchesKbDocumentListFilter(bundle, {
          domain: input.domain,
          tag: input.tag,
          includeArchived,
        })
      ) {
        bundles.push(bundle);
      }
    }
  }

  if (scope === "shared" || scope === "all") {
    if (!ports.projection) {
      throw new KbQueryError("repo_unavailable", "Shared KB projection is unavailable.");
    }
    if (scope === "shared") {
      const sharedCursor = cursor.startsWith("shared:") ? cursor.slice("shared:".length) : cursor;
      const page = ports.projection.readKbDocuments({
        by: "list",
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        ...(input.tag === undefined ? {} : { tag: input.tag }),
        includeArchived,
        limit,
        ...(sharedCursor ? { cursor: sharedCursor } : {}),
      });
      if (page.status !== "ready") {
        throw new KbQueryError(
          "projection_pending",
          `Shared KB projection is catching up (${page.watermark}/${page.sourceRevision}).`,
        );
      }
      return {
        schema: "kb-catalog/v1",
        scope,
        includeArchived,
        items: page.records.map((record) => kbCatalogCardFromBundle(record, maxSummaryChars)),
        nextCursor: page.nextCursor ? `shared:${page.nextCursor}` : null,
        watermark: page.watermark,
        sourceRevision: page.sourceRevision,
      };
    }
    const shared = readAllSharedBundles(ports.projection, {
      domain: input.domain,
      tag: input.tag,
      includeArchived,
    });
    watermark = shared.watermark;
    sourceRevision = shared.sourceRevision;
    bundles.push(...shared.bundles);
  } else if (ports.projection) {
    const cut = ports.projection.readCut();
    watermark = cut.watermark;
    sourceRevision = cut.sourceRevision;
  }

  const ordered = bundles.sort((left, right) => catalogSortKey(left).localeCompare(catalogSortKey(right)));
  const afterCursor = cursor ? ordered.filter((bundle) => catalogSortKey(bundle) > cursor) : ordered;
  const pageItems = afterCursor.slice(0, limit);
  const nextCursor =
    afterCursor.length > limit && pageItems.length > 0 ? catalogSortKey(pageItems[pageItems.length - 1]!) : null;

  return {
    schema: "kb-catalog/v1",
    scope,
    includeArchived,
    items: pageItems.map((bundle) => kbCatalogCardFromBundle(bundle, maxSummaryChars)),
    nextCursor,
    watermark,
    sourceRevision,
  };
}

function resolveBundleById(ports: KbReadPorts, docId: string, scope: KbQueryScope): KbDocumentBundleV1 {
  if (!isValidKbDocId(docId)) {
    throw new KbQueryError("invalid_field", `Invalid KB docId "${docId}". Expected doc_<id>.`);
  }
  if (scope === "local") {
    const local = ports.localStore?.getBundle(docId) ?? null;
    if (!local) throw new KbQueryError("entity_not_found", `Local KB document ${docId} was not found.`);
    return local;
  }
  if (scope === "shared") {
    if (!ports.projection) throw new KbQueryError("repo_unavailable", "Shared KB projection is unavailable.");
    const read = ports.projection.readKbDocuments({ by: "id", docId });
    if (read.status !== "ready") {
      throw new KbQueryError(
        "projection_pending",
        `Shared KB projection is catching up (${read.watermark}/${read.sourceRevision}).`,
      );
    }
    const shared = read.records[0];
    if (!shared) throw new KbQueryError("entity_not_found", `Shared KB document ${docId} was not found.`);
    return shared;
  }

  if (ports.projection) {
    const read = ports.projection.readKbDocuments({ by: "id", docId });
    if (read.status !== "ready") {
      throw new KbQueryError(
        "projection_pending",
        `Shared KB projection is catching up (${read.watermark}/${read.sourceRevision}).`,
      );
    }
    if (read.records[0]) return read.records[0];
  }
  const local = ports.localStore?.getBundle(docId) ?? null;
  if (local) return local;
  throw new KbQueryError("entity_not_found", `KB document ${docId} was not found in shared or local scope.`);
}

export function readKbOutline(ports: KbReadPorts, input: KbOutlineQueryInput): KbOutlineResult {
  const scope = resolveQueryScope(input.scope);
  const bundle = resolveBundleById(ports, input.docId, scope);
  return {
    schema: "kb-outline/v1",
    docId: bundle.docId,
    scope: bundle.scope,
    revision: bundle.revision,
    title: bundle.manifest.title,
    status: bundle.manifest.status,
    domain: bundle.manifest.domain,
    lineCount: bundle.view.lineCount,
    outline: bundle.manifest.outline,
  };
}

export function readKbDocument(ports: KbReadPorts, input: KbDocumentReadInput): KbDocumentReadResult {
  const scope = resolveQueryScope(input.scope);
  const bundle = resolveBundleById(ports, input.docId, scope);
  let viewMarkdown: string | null = null;
  if (bundle.scope === "local") {
    viewMarkdown = ports.localStore?.readView(bundle.docId) ?? null;
  } else {
    const bytes = ports.readContentBlob?.(bundle.view.sha256) ?? null;
    if (bytes !== null) {
      viewMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  }
  if (viewMarkdown === null) {
    throw new KbQueryError("invalid_store", `KB view blob for ${bundle.docId} is unavailable.`);
  }

  let lines: { readonly start: number; readonly end: number } | undefined;
  if (typeof input.lines === "string") {
    const parsed = parseLineRangeSpec(input.lines);
    if (!parsed) {
      throw new KbQueryError(
        "invalid_field",
        `Invalid --lines range "${input.lines}". Expected start..end (e.g. 1..40).`,
      );
    }
    lines = parsed;
  } else if (input.lines !== undefined) {
    lines = input.lines;
  }

  const sliced = readKbViewContent(viewMarkdown, {
    ...(input.section === undefined ? {} : { section: input.section }),
    ...(lines === undefined ? {} : { lines }),
    ...(input.full === true ? { full: true } : {}),
  });
  if (!sliced.ok) {
    throw new KbQueryError(sliced.code, sliced.message);
  }
  return {
    schema: "kb-read/v1",
    docId: bundle.docId,
    scope: bundle.scope,
    revision: bundle.revision,
    title: bundle.manifest.title,
    status: bundle.manifest.status,
    mode: sliced.mode,
    ...(sliced.section === undefined ? {} : { section: sliced.section }),
    startLine: sliced.startLine,
    endLine: sliced.endLine,
    totalLines: sliced.totalLines,
    content: sliced.content,
  };
}
