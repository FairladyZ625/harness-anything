export const OPAQUE_TEXTUAL_POLICY_ID = "opaque-textual-whole-file/v1";
export const OPAQUE_TEXTUAL_MEDIA_TYPE = "text/x-harness-opaque";
export type OpaqueTextualMediaType = "application/json" | "application/yaml" | "text/css" | "text/csv" | "text/html" | "text/javascript" | "text/markdown" | "text/plain" | typeof OPAQUE_TEXTUAL_MEDIA_TYPE;

export type TextualArtifactClassification = Readonly<{
  kind: "canonical-prose" | "opaque-textual";
  mediaType: "text/markdown" | "text/plain" | OpaqueTextualMediaType;
  policyId: "markdown-body-replaceable/v1" | typeof OPAQUE_TEXTUAL_POLICY_ID;
}>;

/**
 * Classifies authored document paths that doc-sync may process. Task artifact
 * directories are opaque regardless of their content type; prose semantics
 * apply everywhere else only to Markdown and plain-text documents.
 */
export function classifyTextualArtifactPath(value: string): TextualArtifactClassification | null {
  if (artifactPath(value)) return { kind: "opaque-textual", mediaType: opaqueTextualMediaType(value), policyId: OPAQUE_TEXTUAL_POLICY_ID };
  if (value.endsWith(".md")) return { kind: "canonical-prose", mediaType: "text/markdown", policyId: "markdown-body-replaceable/v1" };
  if (value.endsWith(".txt")) return { kind: "canonical-prose", mediaType: "text/plain", policyId: "markdown-body-replaceable/v1" };
  return null;
}

export function isOpaqueTextualMediaType(value: unknown): value is OpaqueTextualMediaType {
  return value === "application/json" || value === "application/yaml" || value === "text/css" || value === "text/csv" || value === "text/html" || value === "text/javascript" || value === "text/markdown" || value === "text/plain" || value === OPAQUE_TEXTUAL_MEDIA_TYPE;
}

function artifactPath(value: string): boolean {
  return value.startsWith("artifacts/") || /^tasks\/[^/]+\/artifacts(?:\/|$)/u.test(value);
}

function opaqueTextualMediaType(value: string): OpaqueTextualMediaType {
  if (value.endsWith(".md")) return "text/markdown";
  if (value.endsWith(".txt")) return "text/plain";
  if (value.endsWith(".html") || value.endsWith(".htm")) return "text/html";
  if (value.endsWith(".mjs") || value.endsWith(".js")) return "text/javascript";
  if (value.endsWith(".json")) return "application/json";
  if (value.endsWith(".css")) return "text/css";
  if (value.endsWith(".yaml") || value.endsWith(".yml")) return "application/yaml";
  if (value.endsWith(".csv")) return "text/csv";
  return OPAQUE_TEXTUAL_MEDIA_TYPE;
}
