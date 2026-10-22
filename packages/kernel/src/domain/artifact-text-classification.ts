export const OPAQUE_TEXTUAL_POLICY_ID = "opaque-textual-whole-file/v1";
export const OPAQUE_TEXTUAL_MEDIA_TYPE = "text/x-harness-opaque";
// Doc sync is an inline prose channel capped by its 256 KiB descriptor frame.
// Larger raw content belongs to the <=50,000,000 byte blob contract in dec_776B4D61DF711D9F31126D375D.
export const DOC_SYNC_INLINE_MAX_BYTES = 256 * 1024;
/**
 * Task outputs that are not text at all — PDF, PNG, a compiled binary, a log with a lone 0x80 byte.
 * They ride the same content claim schema and the same content-object store as prose; the only thing
 * this policy changes is that nothing between the claim and the worktree decodes the bytes.
 */
export const RAW_ARTIFACT_POLICY_ID = "raw-artifact-bytes/v1";
export const RAW_ARTIFACT_MEDIA_TYPE = "application/octet-stream";
/** The <=50,000,000 byte blob contract in dec_776B4D61DF711D9F31126D375D, shared with entity-owned content. */
export const RAW_ARTIFACT_MAX_BYTES = 50_000_000;

export type RawArtifactClassification = Readonly<{
  kind: "raw-artifact";
  mediaType: typeof RAW_ARTIFACT_MEDIA_TYPE;
  policyId: typeof RAW_ARTIFACT_POLICY_ID;
}>;
export type OpaqueTextualMediaType =
  | "application/json"
  | "application/yaml"
  | "text/css"
  | "text/csv"
  | "text/html"
  | "text/javascript"
  | "text/markdown"
  | "text/plain"
  | typeof OPAQUE_TEXTUAL_MEDIA_TYPE;

export type TextualArtifactClassification = Readonly<{
  kind: "canonical-prose" | "opaque-textual";
  mediaType: "text/markdown" | "text/plain" | OpaqueTextualMediaType;
  policyId: "markdown-body-replaceable/v1" | typeof OPAQUE_TEXTUAL_POLICY_ID;
}>;

const textualFileTypes: readonly {
  readonly extensions: readonly string[];
  readonly mediaType: OpaqueTextualMediaType;
  readonly docSyncCandidate: boolean;
  readonly worktreeDocument: boolean;
}[] = [
  { extensions: [".md"], mediaType: "text/markdown", docSyncCandidate: true, worktreeDocument: true },
  { extensions: [".txt"], mediaType: "text/plain", docSyncCandidate: true, worktreeDocument: true },
  { extensions: [".html", ".htm"], mediaType: "text/html", docSyncCandidate: true, worktreeDocument: true },
  { extensions: [".json"], mediaType: "application/json", docSyncCandidate: false, worktreeDocument: true },
  { extensions: [".yaml", ".yml"], mediaType: "application/yaml", docSyncCandidate: false, worktreeDocument: true },
  { extensions: [".mjs", ".js"], mediaType: "text/javascript", docSyncCandidate: false, worktreeDocument: false },
  { extensions: [".css"], mediaType: "text/css", docSyncCandidate: false, worktreeDocument: false },
  { extensions: [".csv"], mediaType: "text/csv", docSyncCandidate: false, worktreeDocument: false },
];

/**
 * Classifies authored document paths that doc-sync may process. Task artifact
 * directories, authored architecture models, and the walls manifest are opaque regardless of
 * their content type; prose semantics apply everywhere else only to Markdown
 * and plain-text documents. Other supported textual formats are whole-file
 * documents. This is the path-shape judgment only: `classifyDocCandidate` is the one entry that
 * reads bytes to choose raw content, so a binary name that already holds a persisted text
 * document still answers with that policy instead of becoming unwritable.
 */
export function classifyTextualArtifactPath(value: string): TextualArtifactClassification | null {
  if (artifactPath(value) || architectureModelPath(value) || value === "governance/walls/walls.json")
    return classifyOpaqueTextualArtifactPath(value);
  const fileType = textualFileType(value);
  if (fileType === null || !fileType.docSyncCandidate) return null;
  const { mediaType } = fileType;
  return mediaType === "text/markdown" || mediaType === "text/plain"
    ? { kind: "canonical-prose", mediaType, policyId: "markdown-body-replaceable/v1" }
    : { kind: "opaque-textual", mediaType, policyId: OPAQUE_TEXTUAL_POLICY_ID };
}

/**
 * Where raw bytes may live: inside a registered task's own `artifacts/` subtree, at a name that claims no
 * textual format. A `.md` or `.json` artifact that will not decode is a broken text file and stays an
 * error; a `.pdf`, `.png`, or `.log` never promised to be text in the first place. Prose routes are
 * untouched either way, so an undecodable file becomes a document only because a Task claimed it here.
 */
export function classifyRawArtifactPath(value: string): RawArtifactClassification | null {
  return taskArtifactSubtreePath(value) && textualFileType(value) === null
    ? { kind: "raw-artifact", mediaType: RAW_ARTIFACT_MEDIA_TYPE, policyId: RAW_ARTIFACT_POLICY_ID }
    : null;
}

/**
 * Opaque whole-file classification for a path whose bytes the caller already
 * proved textual. The media type keeps the table mapping when the extension
 * has one and falls back to the opaque marker otherwise.
 */
export function classifyOpaqueTextualArtifactPath(value: string): TextualArtifactClassification {
  return { kind: "opaque-textual", mediaType: opaqueTextualMediaType(value), policyId: OPAQUE_TEXTUAL_POLICY_ID };
}

export function taskArtifactSubtreePath(value: string): boolean {
  return /^tasks\/[^/]+\/artifacts\/.+/u.test(value);
}

/**
 * Any path inside an authored artifacts subtree: the repository-level `artifacts/`, a task package's,
 * or a Decision package's. Content there rides the blob content contract rather than the inline
 * prose channel, whatever its extension.
 */
export function artifactSubtreePath(value: string): boolean {
  return artifactPath(value);
}

export function isOpaqueTextualMediaType(value: unknown): value is OpaqueTextualMediaType {
  return (
    value === "application/json" ||
    value === "application/yaml" ||
    value === "text/css" ||
    value === "text/csv" ||
    value === "text/html" ||
    value === "text/javascript" ||
    value === "text/markdown" ||
    value === "text/plain" ||
    value === OPAQUE_TEXTUAL_MEDIA_TYPE
  );
}

export function worktreeDocumentMediaType(value: string): OpaqueTextualMediaType | null {
  const fileType = textualFileType(value);
  return fileType?.worktreeDocument ? fileType.mediaType : null;
}

function artifactPath(value: string): boolean {
  return (
    value.startsWith("artifacts/") || /^(?:tasks\/[^/]+|decisions\/decision-[^/]+)\/artifacts(?:\/|$)/u.test(value)
  );
}

function architectureModelPath(value: string): boolean {
  return (
    value === "context/architecture/architecture-manifest.json" || /^context\/architecture\/model\/.+\.c4$/u.test(value)
  );
}

function opaqueTextualMediaType(value: string): OpaqueTextualMediaType {
  return textualFileType(value)?.mediaType ?? OPAQUE_TEXTUAL_MEDIA_TYPE;
}

function textualFileType(value: string): (typeof textualFileTypes)[number] | null {
  const extension = extensionOf(value);
  return textualFileTypes.find((fileType) => fileType.extensions.includes(extension)) ?? null;
}

function extensionOf(value: string): string {
  return value.slice(value.lastIndexOf(".")).toLowerCase();
}

export type DocCandidateClassification = TextualArtifactClassification | RawArtifactClassification;

/** Media type by artifact name. `textual` names promise a text decoder may read the bytes. */
const artifactMediaTypes: readonly {
  readonly extensions: readonly string[];
  readonly mediaType: string;
  readonly textual?: true;
}[] = [
  { extensions: [".png"], mediaType: "image/png" },
  { extensions: [".jpg", ".jpeg"], mediaType: "image/jpeg" },
  { extensions: [".gif"], mediaType: "image/gif" },
  { extensions: [".webp"], mediaType: "image/webp" },
  { extensions: [".avif"], mediaType: "image/avif" },
  { extensions: [".bmp"], mediaType: "image/bmp" },
  { extensions: [".ico"], mediaType: "image/x-icon" },
  { extensions: [".svg"], mediaType: "image/svg+xml", textual: true },
  { extensions: [".pdf"], mediaType: "application/pdf" },
  { extensions: [".docx"], mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  { extensions: [".doc"], mediaType: "application/msword" },
  { extensions: [".pptx"], mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  { extensions: [".ppt"], mediaType: "application/vnd.ms-powerpoint" },
  { extensions: [".xlsx"], mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { extensions: [".xlsm"], mediaType: "application/vnd.ms-excel.sheet.macroEnabled.12" },
  { extensions: [".xls"], mediaType: "application/vnd.ms-excel" },
  { extensions: [".ods"], mediaType: "application/vnd.oasis.opendocument.spreadsheet" },
];

/** The media type an artifact name claims, or the caller's fallback when the name claims none. */
export function mediaTypeForBinaryPath(relative: string, fallback: string | null = null): string | null {
  return artifactFileType(extensionOf(relative))?.mediaType ?? fallback;
}

function artifactFileType(extension: string): (typeof artifactMediaTypes)[number] | null {
  return artifactMediaTypes.find((fileType) => fileType.extensions.includes(extension)) ?? null;
}

function isBinaryArtifactPath(value: string): boolean {
  const fileType = artifactFileType(extensionOf(value));
  return fileType !== null && fileType.textual !== true;
}

/** Valid UTF-8 without a NUL byte is text; every other byte sequence is raw content. */
function isTextualBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * One doc-sync verdict for a candidate path and, when it is readable, its bytes.
 *
 * Inside a task's `artifacts/` subtree, a name that claims a text format is a document only while
 * its bytes decode — a broken text file stays an error — and every other name is decided by the
 * bytes, so a PNG dropped there submits instead of routing the operator to a second entry point.
 * Outside that subtree only names that claim text, or bytes that decode, are documents.
 */
export function classifyDocCandidate(path: string, bytes: Uint8Array | null = null): DocCandidateClassification | null {
  const inArtifacts = taskArtifactSubtreePath(path),
    undecodable = bytes !== null && !isTextualBytes(bytes),
    raw: RawArtifactClassification = {
      kind: "raw-artifact",
      mediaType: RAW_ARTIFACT_MEDIA_TYPE,
      policyId: RAW_ARTIFACT_POLICY_ID,
    };
  if (inArtifacts && textualFileType(path) !== null)
    return undecodable ? null : classifyOpaqueTextualArtifactPath(path);
  if (inArtifacts) return isBinaryArtifactPath(path) || undecodable ? raw : classifyOpaqueTextualArtifactPath(path);
  const textual = classifyTextualArtifactPath(path);
  return textual ?? (bytes !== null && !undecodable ? classifyOpaqueTextualArtifactPath(path) : null);
}

/**
 * The verdict that governs an *existing* document. A row written under a textual policy keeps that
 * policy: bytes that read as raw today (a binary name, or text carrying a NUL byte) are an edit of a
 * persisted document, not a new artifact at the same name, so the path judgment answers for it. The
 * write boundary then judges the edit itself (`decideDocWrite` answers `semantic_policy_changed` when
 * a new policy would replace the written one).
 *
 * The one implementation of that rule. Callers pass the byte verdict they already need for their own
 * scope decision, so this adds no second decode and no second classifier.
 */
export function effectiveDocCandidateClassification(
  path: string,
  classified: DocCandidateClassification | null,
  persistedPolicyId: string | null,
): DocCandidateClassification | null {
  return (classified === null || classified.kind === "raw-artifact") &&
    persistedPolicyId !== null &&
    persistedPolicyId !== RAW_ARTIFACT_POLICY_ID
    ? classifyTextualArtifactPath(path)
    : classified;
}
