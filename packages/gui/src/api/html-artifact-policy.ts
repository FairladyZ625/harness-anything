export const HTML_ARTIFACT_PARTITION = "html-artifact-preview";
export const HTML_ARTIFACT_DATA_URL_PREFIX = "data:text/html;charset=utf-8,";

export function buildHtmlArtifactDataUrl(content: string): string {
  return `${HTML_ARTIFACT_DATA_URL_PREFIX}${encodeURIComponent(content)}`;
}

export function isAllowedHtmlArtifactAttachment(params: Readonly<Record<string, string>>): boolean {
  return params.partition === HTML_ARTIFACT_PARTITION && params.src.startsWith(HTML_ARTIFACT_DATA_URL_PREFIX);
}

export function isAllowedHtmlArtifactRequest(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "data:" || protocol === "about:";
  } catch {
    return false;
  }
}
