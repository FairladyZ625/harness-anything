import { hasOnlyFields, hasRequiredFields, isRecord } from "./write-chain.contract.ts";
import { timestamp } from "./timestamp.ts";

/**
 * Pure deterministic POSIX relative path normalizer (zero `node:path`, zero throw).
 * Rejects empty paths, absolute/drive paths, control chars, `.` / `..` segments, and trailing slashes.
 */
export function tryNormalizeRelativePosixPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
  if (/^[A-Za-z]:/u.test(trimmed)) return null;
  const unified = trimmed.replaceAll("\\", "/");
  const segments = unified.split("/");
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
  }
  return segments.join("/");
}

export const KB_DOCUMENT_BUNDLE_SCHEMA = "kb-document-bundle/v1";
export const KB_CATALOG_DEFAULT_LIMIT = 20;
export const KB_CATALOG_MAX_LIMIT = 100;
export const KB_CATALOG_DEFAULT_SUMMARY_CHARS = 240;
export const KB_CATALOG_MAX_SUMMARY_CHARS = 2000;

export const kbDocumentStatuses = Object.freeze(["active", "superseded", "rejected"] as const);
export type KbDocumentStatus = (typeof kbDocumentStatuses)[number];

export const kbScopes = Object.freeze(["local", "shared"] as const);
export type KbScope = (typeof kbScopes)[number];

export const kbQueryScopes = Object.freeze(["local", "shared", "all"] as const);
export type KbQueryScope = (typeof kbQueryScopes)[number];

export const kbMountModes = Object.freeze(["readonly", "readwrite"] as const);
export type KbMountMode = (typeof kbMountModes)[number];

export const kbRelationTypes = Object.freeze([
  "supersedes",
  "references",
  "derived-from",
  "related-to",
  "depends-on",
] as const);
export type KbRelationType = (typeof kbRelationTypes)[number];

export const KB_DOC_ID_PATTERN = /^doc_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export const KB_MOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export interface KbDocumentRelation {
  readonly type: KbRelationType;
  readonly target: string;
  readonly label?: string;
}

export interface KbOutlineHeading {
  readonly heading: string;
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly startLine: number;
  readonly endLine: number;
  readonly slug: string;
  readonly page?: number;
}

export interface KbDocumentManifestV1 {
  readonly title: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly domain: string;
  readonly tags: readonly string[];
  readonly status: KbDocumentStatus;
  readonly supersededBy?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly relations: readonly KbDocumentRelation[];
  readonly outline: readonly KbOutlineHeading[];
}

export interface KbDocumentSourceRefV1 {
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface KbDocumentViewRefV1 {
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly lineCount: number;
}

export interface KbDocumentAssetRefV1 {
  readonly path: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly page?: number;
}

export interface KbDocumentBundleV1 {
  readonly schema: typeof KB_DOCUMENT_BUNDLE_SCHEMA;
  readonly docId: string;
  readonly scope: KbScope;
  readonly revision: number;
  readonly manifest: KbDocumentManifestV1;
  readonly source: KbDocumentSourceRefV1;
  readonly view: KbDocumentViewRefV1;
  readonly assets: readonly KbDocumentAssetRefV1[];
  readonly updatedAt: string;
  readonly mountId?: string;
  readonly mountRelativePath?: string;
}

export interface KbMountDeclarationV1 {
  readonly mountId: string;
  readonly rootPath: string;
  readonly mode: KbMountMode;
  readonly domain?: string;
  readonly tags?: readonly string[];
  readonly addedAt: string;
}

export interface KbAssetWriteInput {
  readonly path: string;
  readonly mediaType: string;
  readonly body: Uint8Array;
  readonly page?: number;
}

export interface LocalKbWriteInput {
  readonly docId: string;
  readonly manifest: Omit<KbDocumentManifestV1, "outline"> & { readonly outline?: readonly KbOutlineHeading[] };
  readonly viewMarkdown: string;
  readonly sourceFilename?: string;
  readonly sourceMediaType?: string;
  readonly sourceBytes?: Uint8Array;
  readonly assets?: readonly KbAssetWriteInput[];
  readonly expectedVersion?: number;
  readonly now: string;
}

export interface LocalKbStorePort {
  readonly listBundles: () => readonly KbDocumentBundleV1[];
  readonly getBundle: (docId: string) => KbDocumentBundleV1 | null;
  readonly readView: (docId: string) => string | null;
  readonly putBundle: (input: LocalKbWriteInput) => KbDocumentBundleV1;
  readonly removeBundle: (docId: string, options?: { readonly expectedVersion?: number }) => boolean;
  readonly listMounts: () => readonly KbMountDeclarationV1[];
  readonly addMount: (input: {
    readonly mountId: string;
    readonly rootPath: string;
    readonly mode: KbMountMode;
    readonly domain?: string;
    readonly tags?: readonly string[];
    readonly now: string;
  }) => KbMountDeclarationV1;
  readonly removeMount: (mountId: string) => boolean;
  readonly writeMountedMarkdown?: (input: {
    readonly mountId: string;
    readonly relativePath: string;
    readonly markdown: string;
  }) => KbDocumentBundleV1;
}

export interface KbCatalogCardV1 {
  readonly docId: string;
  readonly scope: KbScope;
  readonly revision: number;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly domain: string;
  readonly tags: readonly string[];
  readonly status: KbDocumentStatus;
  readonly supersededBy: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly headingCount: number;
  readonly lineCount: number;
  readonly sourceMediaType: string;
  readonly updatedAt: string;
  readonly mountId?: string;
  readonly mountRelativePath?: string;
}

export interface KbReadOptions {
  readonly section?: string;
  readonly lines?: { readonly start: number; readonly end: number };
  readonly full?: boolean;
}

export type KbReadSliceResult =
  | {
      readonly ok: true;
      readonly mode: "section" | "lines" | "full";
      readonly section?: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly totalLines: number;
      readonly content: string;
    }
  | {
      readonly ok: false;
      readonly code: "kb_section_not_found" | "kb_section_ambiguous" | "invalid_field";
      readonly message: string;
      readonly matches?: readonly string[];
    };

export interface ParsedKbFrontmatter {
  readonly title?: string;
  readonly docId?: string;
  readonly aliases: readonly string[];
  readonly summary?: string;
  readonly domain?: string;
  readonly tags: readonly string[];
  readonly status?: KbDocumentStatus;
  readonly supersededBy?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly relations: readonly KbDocumentRelation[];
  readonly frontmatterEndLine: number;
}

export function isValidKbDocId(value: unknown): value is string {
  return typeof value === "string" && KB_DOC_ID_PATTERN.test(value);
}

export function isValidKbMountId(value: unknown): value is string {
  return typeof value === "string" && KB_MOUNT_ID_PATTERN.test(value);
}

export function isKbDocumentActive(status: KbDocumentStatus): boolean {
  return status === "active";
}

export function headingSlug(heading: string): string {
  const normalized = heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");
  return normalized || "section";
}

function splitMarkdownLines(markdown: string): readonly string[] {
  if (markdown.length === 0) return [];
  const normalized = markdown.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function countMarkdownLines(markdown: string): number {
  return splitMarkdownLines(markdown).length;
}

function findFrontmatterClosingIndex(lines: readonly string[]): number {
  if (lines.length < 2 || lines[0]?.trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "---" || trimmed === "...") return i;
  }
  return -1;
}

/**
 * Deterministic zero-LLM Markdown heading tree parser.
 * Tracks 1-based inclusive startLine..endLine (including child subsections) and `<!-- page:N -->` anchors.
 */
export function parseMarkdownOutline(markdown: string): readonly KbOutlineHeading[] {
  const lines = splitMarkdownLines(markdown);
  if (lines.length === 0) return [];
  const fmEnd = findFrontmatterClosingIndex(lines);
  const startIndex = fmEnd >= 0 ? fmEnd + 1 : 0;

  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let currentPage: number | undefined;
  const rawHeadings: Array<{
    heading: string;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    startLine: number;
    slug: string;
    page?: number;
  }> = [];

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const char = marker[0] as "`" | "~";
      if (fenceChar === null) {
        fenceChar = char;
        fenceLen = marker.length;
        continue;
      }
      if (fenceChar === char && marker.length >= fenceLen && fenceMatch[2]!.trim() === "") {
        fenceChar = null;
        fenceLen = 0;
        continue;
      }
    }
    if (fenceChar !== null) continue;

    const pageMatch = /<!--\s*page:([1-9][0-9]*)\s*-->/iu.exec(line);
    if (pageMatch) {
      currentPage = Number(pageMatch[1]);
    }

    const headingMatch = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u.exec(line);
    if (!headingMatch) continue;
    const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
    const heading = headingMatch[2]!.trim();
    if (!heading) continue;
    rawHeadings.push({
      heading,
      level,
      startLine: i + 1,
      slug: headingSlug(heading),
      ...(currentPage === undefined ? {} : { page: currentPage }),
    });
  }

  return rawHeadings.map((entry, idx) => {
    let endLine = lines.length;
    for (let next = idx + 1; next < rawHeadings.length; next += 1) {
      if (rawHeadings[next]!.level <= entry.level) {
        endLine = rawHeadings[next]!.startLine - 1;
        break;
      }
    }
    return {
      heading: entry.heading,
      level: entry.level,
      startLine: entry.startLine,
      endLine: Math.max(entry.startLine, endLine),
      slug: entry.slug,
      ...(entry.page === undefined ? {} : { page: entry.page }),
    };
  });
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
  }
  return trimmed;
}

function parseInlineYamlList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => unquoteYamlScalar(item))
    .filter((item) => item.length > 0);
}

function parseRelationToken(raw: string): KbDocumentRelation | null {
  const cleaned = unquoteYamlScalar(raw);
  const idx = cleaned.indexOf(":");
  if (idx <= 0) return null;
  const type = cleaned.slice(0, idx).trim() as KbRelationType;
  const target = cleaned.slice(idx + 1).trim();
  if (!(kbRelationTypes as readonly string[]).includes(type) || !target) return null;
  return { type, target };
}

/** Deterministic lightweight frontmatter parser for local/mounted Markdown files. */
export function parseKbMarkdownFrontmatter(markdown: string): ParsedKbFrontmatter {
  const lines = splitMarkdownLines(markdown);
  const fmEnd = findFrontmatterClosingIndex(lines);
  if (fmEnd < 0) {
    return { aliases: [], tags: [], relations: [], frontmatterEndLine: 0 };
  }

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let activeListKey: string | null = null;

  for (let i = 1; i < fmEnd; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItemMatch = /^[ \t]+-[ \t]+(.+)$/u.exec(line);
    if (listItemMatch && activeListKey !== null) {
      const bucket = lists.get(activeListKey) ?? [];
      bucket.push(unquoteYamlScalar(listItemMatch[1]!));
      lists.set(activeListKey, bucket);
      continue;
    }

    const kvMatch = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/u.exec(line);
    if (!kvMatch) {
      activeListKey = null;
      continue;
    }
    const key = kvMatch[1]!.trim();
    const rawVal = kvMatch[2]!.trim();
    if (rawVal === "") {
      activeListKey = key;
      if (!lists.has(key)) lists.set(key, []);
    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      activeListKey = null;
      lists.set(key, parseInlineYamlList(rawVal));
    } else {
      activeListKey = null;
      scalars.set(key, unquoteYamlScalar(rawVal));
    }
  }

  const rawStatus = scalars.get("status");
  const status =
    rawStatus && (kbDocumentStatuses as readonly string[]).includes(rawStatus)
      ? (rawStatus as KbDocumentStatus)
      : undefined;
  const rawDocId = scalars.get("docId") ?? scalars.get("doc_id") ?? scalars.get("id");
  const docId = rawDocId && isValidKbDocId(rawDocId) ? rawDocId : undefined;
  const supersededBy = scalars.get("supersededBy") ?? scalars.get("superseded_by");
  const validFrom = scalars.get("validFrom") ?? scalars.get("valid_from");
  const validTo = scalars.get("validTo") ?? scalars.get("valid_to");
  const rawRelations = lists.get("relations") ?? [];
  const relations = rawRelations.map(parseRelationToken).filter((entry): entry is KbDocumentRelation => entry !== null);

  return {
    ...(scalars.get("title") ? { title: scalars.get("title")! } : {}),
    ...(docId ? { docId } : {}),
    aliases: lists.get("aliases") ?? [],
    ...(scalars.get("summary") ? { summary: scalars.get("summary")! } : {}),
    ...(scalars.get("domain") ? { domain: scalars.get("domain")! } : {}),
    tags: lists.get("tags") ?? [],
    ...(status ? { status } : {}),
    ...(supersededBy && supersededBy !== "null" ? { supersededBy } : {}),
    ...(validFrom && validFrom !== "null" ? { validFrom } : {}),
    ...(validTo && validTo !== "null" ? { validTo } : {}),
    relations,
    frontmatterEndLine: fmEnd + 1,
  };
}

export function parseLineRangeSpec(raw: string): { readonly start: number; readonly end: number } | null {
  const match = /^([1-9][0-9]*)\.\.([1-9][0-9]*)$/u.exec(raw.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

/**
 * Pure deterministic KB document reader: complete section (`--section`), exact line range (`--lines`),
 * or full document (`--full`). Strictly zero 500-token chunking.
 */
export function readKbViewContent(viewMarkdown: string, options: KbReadOptions = {}): KbReadSliceResult {
  const lines = splitMarkdownLines(viewMarkdown);
  const totalLines = lines.length;
  const modeCount = [options.section !== undefined, options.lines !== undefined, options.full === true].filter(
    Boolean,
  ).length;
  if (modeCount > 1) {
    return {
      ok: false,
      code: "invalid_field",
      message: "Choose at most one of --section, --lines, or --full.",
    };
  }

  if (options.lines !== undefined) {
    const { start, end } = options.lines;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      return {
        ok: false,
        code: "invalid_field",
        message: "Line range must be 1-based positive integers with start <= end.",
      };
    }
    if (totalLines === 0 || start > totalLines) {
      return {
        ok: false,
        code: "invalid_field",
        message: `Requested start line ${start} exceeds document length (${totalLines} lines).`,
      };
    }
    const clampedEnd = Math.min(end, totalLines);
    return {
      ok: true,
      mode: "lines",
      startLine: start,
      endLine: clampedEnd,
      totalLines,
      content: lines.slice(start - 1, clampedEnd).join("\n"),
    };
  }

  if (options.section !== undefined) {
    const query = options.section.trim();
    if (!query) {
      return { ok: false, code: "invalid_field", message: "--section must be a non-empty heading or slug." };
    }
    const outline = parseMarkdownOutline(viewMarkdown);
    const lowerQuery = query.toLowerCase();
    const slugQuery = headingSlug(query);

    let matches = outline.filter((node) => node.heading.toLowerCase() === lowerQuery);
    if (matches.length === 0) matches = outline.filter((node) => node.slug === slugQuery);
    if (matches.length === 0) {
      matches = outline.filter(
        (node) => node.heading.toLowerCase().startsWith(lowerQuery) || node.slug.startsWith(slugQuery),
      );
    }
    if (matches.length === 0) {
      return {
        ok: false,
        code: "kb_section_not_found",
        message: `Section "${query}" was not found in document outline.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "kb_section_ambiguous",
        message: `Section "${query}" matched ${matches.length} headings: ${matches.map((m) => m.heading).join(", ")}.`,
        matches: matches.map((m) => m.heading),
      };
    }
    const chosen = matches[0]!;
    return {
      ok: true,
      mode: "section",
      section: chosen.heading,
      startLine: chosen.startLine,
      endLine: chosen.endLine,
      totalLines,
      content: lines.slice(chosen.startLine - 1, chosen.endLine).join("\n"),
    };
  }

  return {
    ok: true,
    mode: "full",
    startLine: totalLines === 0 ? 0 : 1,
    endLine: totalLines,
    totalLines,
    content: lines.join("\n"),
  };
}

export function kbCatalogCardFromBundle(
  bundle: KbDocumentBundleV1,
  maxSummaryChars = KB_CATALOG_DEFAULT_SUMMARY_CHARS,
): KbCatalogCardV1 {
  const budget = Math.max(1, Math.min(KB_CATALOG_MAX_SUMMARY_CHARS, Math.floor(maxSummaryChars)));
  const rawSummary = bundle.manifest.summary.trim();
  const summaryTruncated = rawSummary.length > budget;
  const summary = summaryTruncated ? `${rawSummary.slice(0, Math.max(1, budget - 1)).trimEnd()}…` : rawSummary;
  return {
    docId: bundle.docId,
    scope: bundle.scope,
    revision: bundle.revision,
    title: bundle.manifest.title,
    aliases: bundle.manifest.aliases,
    summary,
    summaryTruncated,
    domain: bundle.manifest.domain,
    tags: bundle.manifest.tags,
    status: bundle.manifest.status,
    supersededBy: bundle.manifest.supersededBy ?? null,
    validFrom: bundle.manifest.validFrom ?? null,
    validTo: bundle.manifest.validTo ?? null,
    headingCount: bundle.manifest.outline.length,
    lineCount: bundle.view.lineCount,
    sourceMediaType: bundle.source.mediaType,
    updatedAt: bundle.updatedAt,
    ...(bundle.mountId ? { mountId: bundle.mountId } : {}),
    ...(bundle.mountRelativePath ? { mountRelativePath: bundle.mountRelativePath } : {}),
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateOutlineEntry(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (!isRecord(value)) return ["kb outline entry must be an object"];
  const required = ["heading", "level", "startLine", "endLine", "slug"];
  const allowed = [...required, "page"];
  if (
    !hasRequiredFields(value, required) ||
    (!allowUnknownFields && Object.keys(value).some((key) => !allowed.includes(key)))
  )
    return ["kb outline entry fields are invalid"];
  if (
    typeof value.heading !== "string" ||
    !value.heading.trim() ||
    !Number.isSafeInteger(value.level) ||
    Number(value.level) < 1 ||
    Number(value.level) > 6 ||
    !Number.isSafeInteger(value.startLine) ||
    Number(value.startLine) < 1 ||
    !Number.isSafeInteger(value.endLine) ||
    Number(value.endLine) < Number(value.startLine) ||
    typeof value.slug !== "string" ||
    !value.slug.trim() ||
    (value.page !== undefined && (!Number.isSafeInteger(value.page) || Number(value.page) < 1))
  )
    return ["kb outline entry values are invalid"];
  return [];
}

function validateRelationEntry(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (!isRecord(value)) return ["kb relation must be an object"];
  const required = ["type", "target"];
  const allowed = [...required, "label"];
  if (
    !hasRequiredFields(value, required) ||
    (!allowUnknownFields && Object.keys(value).some((key) => !allowed.includes(key)))
  )
    return ["kb relation fields are invalid"];
  if (
    typeof value.type !== "string" ||
    !(kbRelationTypes as readonly string[]).includes(value.type) ||
    typeof value.target !== "string" ||
    !value.target.trim() ||
    (value.label !== undefined && typeof value.label !== "string")
  )
    return ["kb relation values are invalid"];
  return [];
}

export function validateKbDocumentManifestV1(value: unknown, allowUnknownFields = false): readonly string[] {
  if (!isRecord(value)) return ["kb manifest must be an object"];
  const required = ["title", "aliases", "summary", "domain", "tags", "status", "relations", "outline"];
  const allowed = [...required, "supersededBy", "validFrom", "validTo"];
  if (
    !hasRequiredFields(value, required) ||
    (!allowUnknownFields && Object.keys(value).some((key) => !allowed.includes(key)))
  )
    return ["kb manifest fields are incomplete or unknown"];
  const issues: string[] = [];
  if (typeof value.title !== "string" || !value.title.trim())
    issues.push("kb manifest title must be a non-empty string");
  if (!isStringArray(value.aliases)) issues.push("kb manifest aliases must be a string array");
  if (typeof value.summary !== "string") issues.push("kb manifest summary must be a string");
  if (typeof value.domain !== "string" || !value.domain.trim())
    issues.push("kb manifest domain must be a non-empty string");
  if (!isStringArray(value.tags)) issues.push("kb manifest tags must be a string array");
  if (typeof value.status !== "string" || !(kbDocumentStatuses as readonly string[]).includes(value.status))
    issues.push("kb manifest status must be active, superseded, or rejected");
  if (value.supersededBy !== undefined && value.supersededBy !== null && !isValidKbDocId(value.supersededBy))
    issues.push("kb manifest supersededBy must be a valid doc_<id> or null");
  if (value.validFrom !== undefined && value.validFrom !== null && !timestamp(value.validFrom))
    issues.push("kb manifest validFrom must be an ISO-8601 UTC timestamp or null");
  if (value.validTo !== undefined && value.validTo !== null && !timestamp(value.validTo))
    issues.push("kb manifest validTo must be an ISO-8601 UTC timestamp or null");
  if (!Array.isArray(value.relations)) issues.push("kb manifest relations must be an array");
  else for (const rel of value.relations) issues.push(...validateRelationEntry(rel, allowUnknownFields));
  if (!Array.isArray(value.outline)) issues.push("kb manifest outline must be an array");
  else for (const heading of value.outline) issues.push(...validateOutlineEntry(heading, allowUnknownFields));
  return issues;
}

export function validateKbSourceRefV1(value: unknown, allowUnknownFields = false): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (!isRecord(value) || !hasFields(value, ["filename", "mediaType", "sha256", "byteLength"]))
    return ["kb source ref is invalid"];
  if (
    typeof value.filename !== "string" ||
    !/^source\.[A-Za-z0-9._-]+$/u.test(value.filename) ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.trim() ||
    typeof value.sha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) < 0
  )
    return ["kb source ref values are invalid"];
  return [];
}

export function validateKbViewRefV1(value: unknown, allowUnknownFields = false): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (!isRecord(value) || !hasFields(value, ["filename", "mediaType", "sha256", "byteLength", "lineCount"]))
    return ["kb view ref is invalid"];
  if (
    value.filename !== "view.md" ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.trim() ||
    typeof value.sha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) < 0 ||
    !Number.isSafeInteger(value.lineCount) ||
    Number(value.lineCount) < 0
  )
    return ["kb view ref values are invalid"];
  return [];
}

export function validateKbAssetRefV1(value: unknown, allowUnknownFields = false): readonly string[] {
  if (!isRecord(value)) return ["kb asset ref must be an object"];
  const required = ["path", "mediaType", "sha256", "byteLength"];
  const allowed = [...required, "page"];
  if (
    !hasRequiredFields(value, required) ||
    (!allowUnknownFields && Object.keys(value).some((key) => !allowed.includes(key)))
  )
    return ["kb asset ref fields are invalid"];
  if (
    typeof value.path !== "string" ||
    !value.path.startsWith("assets/") ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.trim() ||
    typeof value.sha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) < 0 ||
    (value.page !== undefined && (!Number.isSafeInteger(value.page) || Number(value.page) < 1))
  )
    return ["kb asset ref values are invalid"];
  if (tryNormalizeRelativePosixPath(value.path) !== value.path) return ["kb asset path is not canonical"];
  return [];
}

export function validateKbDocumentBundleV1(value: unknown, allowUnknownFields = false): readonly string[] {
  if (!isRecord(value)) return ["kb document bundle must be an object"];
  const required = ["schema", "docId", "scope", "revision", "manifest", "source", "view", "assets", "updatedAt"];
  const allowed = [...required, "mountId", "mountRelativePath"];
  if (
    !hasRequiredFields(value, required) ||
    (!allowUnknownFields && Object.keys(value).some((key) => !allowed.includes(key)))
  )
    return ["kb document bundle fields are incomplete or unknown"];
  const issues: string[] = [];
  if (value.schema !== KB_DOCUMENT_BUNDLE_SCHEMA) issues.push(`kb bundle schema must be ${KB_DOCUMENT_BUNDLE_SCHEMA}`);
  if (!isValidKbDocId(value.docId)) issues.push("kb bundle docId must match doc_<id>");
  if (typeof value.scope !== "string" || !(kbScopes as readonly string[]).includes(value.scope))
    issues.push("kb bundle scope must be local or shared");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    issues.push("kb bundle revision must be a positive safe integer");
  if (!timestamp(value.updatedAt)) issues.push("kb bundle updatedAt must be an ISO-8601 UTC timestamp");
  issues.push(...validateKbDocumentManifestV1(value.manifest, allowUnknownFields));
  issues.push(...validateKbSourceRefV1(value.source, allowUnknownFields));
  issues.push(...validateKbViewRefV1(value.view, allowUnknownFields));
  if (!Array.isArray(value.assets)) issues.push("kb bundle assets must be an array");
  else for (const asset of value.assets) issues.push(...validateKbAssetRefV1(asset, allowUnknownFields));
  if (value.mountId !== undefined && !isValidKbMountId(value.mountId)) issues.push("kb bundle mountId is invalid");
  if (value.mountRelativePath !== undefined) {
    if (typeof value.mountRelativePath !== "string") issues.push("kb bundle mountRelativePath must be a string");
    else if (tryNormalizeRelativePosixPath(value.mountRelativePath) !== value.mountRelativePath)
      issues.push("kb bundle mountRelativePath must be a canonical relative POSIX path");
  }
  return issues;
}
