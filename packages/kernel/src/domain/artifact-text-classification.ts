export const OPAQUE_TEXTUAL_POLICY_ID = "opaque-textual-whole-file/v1";
export const OPAQUE_TEXTUAL_MEDIA_TYPE = "text/x-harness-opaque";
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
 * directories and authored architecture model files are opaque regardless of
 * their content type; prose semantics apply everywhere else only to Markdown
 * and plain-text documents. Other supported textual formats are whole-file
 * documents.
 */
export function classifyTextualArtifactPath(value: string): TextualArtifactClassification | null {
  if (artifactPath(value) || architectureModelPath(value))
    return { kind: "opaque-textual", mediaType: opaqueTextualMediaType(value), policyId: OPAQUE_TEXTUAL_POLICY_ID };
  const fileType = textualFileType(value);
  if (fileType === null || !fileType.docSyncCandidate) return null;
  const { mediaType } = fileType;
  return mediaType === "text/markdown" || mediaType === "text/plain"
    ? { kind: "canonical-prose", mediaType, policyId: "markdown-body-replaceable/v1" }
    : { kind: "opaque-textual", mediaType, policyId: OPAQUE_TEXTUAL_POLICY_ID };
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
