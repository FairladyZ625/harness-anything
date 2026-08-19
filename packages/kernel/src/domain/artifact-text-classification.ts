export const OPAQUE_TEXTUAL_POLICY_ID = "opaque-textual-whole-file/v1";
export const OPAQUE_TEXTUAL_MEDIA_TYPE = "text/x-harness-opaque";

export type TextualArtifactClassification = Readonly<{
  kind: "canonical-prose" | "opaque-textual";
  mediaType: "text/markdown" | "text/plain" | typeof OPAQUE_TEXTUAL_MEDIA_TYPE;
  policyId: "markdown-body-replaceable/v1" | typeof OPAQUE_TEXTUAL_POLICY_ID;
}>;

/**
 * Classifies authored document paths that doc-sync may process. Markdown and
 * plain-text documents retain their established prose semantics everywhere;
 * non-prose textual content is admitted only inside a task artifact directory.
 */
export function classifyTextualArtifactPath(value: string): TextualArtifactClassification | null {
  if (value.endsWith(".md")) return { kind: "canonical-prose", mediaType: "text/markdown", policyId: "markdown-body-replaceable/v1" };
  if (value.endsWith(".txt")) return { kind: "canonical-prose", mediaType: "text/plain", policyId: "markdown-body-replaceable/v1" };
  return artifactPath(value) ? { kind: "opaque-textual", mediaType: OPAQUE_TEXTUAL_MEDIA_TYPE, policyId: OPAQUE_TEXTUAL_POLICY_ID } : null;
}

function artifactPath(value: string): boolean {
  return value.startsWith("artifacts/") || /^tasks\/[^/]+\/artifacts(?:\/|$)/u.test(value);
}
