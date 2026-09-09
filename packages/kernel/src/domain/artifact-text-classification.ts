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
 * documents.
 */
export function classifyTextualArtifactPath(value: string): TextualArtifactClassification | null {
  if (artifactPath(value) || architectureModelPath(value) || value === "governance/walls/walls.json")
    return { kind: "opaque-textual", mediaType: opaqueTextualMediaType(value), policyId: OPAQUE_TEXTUAL_POLICY_ID };
  const fileType = textualFileType(value);
  if (fileType === null || !fileType.docSyncCandidate) return null;
  const { mediaType } = fileType;
  return mediaType === "text/markdown" || mediaType === "text/plain"
    ? { kind: "canonical-prose", mediaType, policyId: "markdown-body-replaceable/v1" }
    : { kind: "opaque-textual", mediaType, policyId: OPAQUE_TEXTUAL_POLICY_ID };
}

export function classifyDocSyncCandidatePath(value: string): TextualArtifactClassification | null {
  const classification = classifyTextualArtifactPath(value),
    extension = extensionOf(value);
  return (artifactPath(value) && classification?.mediaType === "application/json") ||
    extension === ".jsonl" ||
    extension === ".log"
    ? null
    : classification;
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

export function taskArtifactSubtreePath(value: string): boolean {
  return /^tasks\/[^/]+\/artifacts\/.+/u.test(value);
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
  return value.startsWith("artifacts/") || /^tasks\/[^/]+\/artifacts(?:\/|$)/u.test(value);
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
