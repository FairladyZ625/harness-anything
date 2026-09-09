export function isRendererRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rendererErrorHint(value: unknown, fallback: string): string {
  return isRendererRecord(value) && isRendererRecord(value.error) && typeof value.error.hint === "string"
    ? value.error.hint
    : fallback;
}

export interface FactDomainTypeSummaryRow {
  readonly domainType: string;
  readonly registeredByFactId: string;
  readonly workspaceRevision: number;
}

export function isFactDomainTypeSummaryRow(value: unknown): value is FactDomainTypeSummaryRow {
  return (
    isRendererRecord(value) &&
    typeof value.domainType === "string" &&
    typeof value.registeredByFactId === "string" &&
    Number.isSafeInteger(value.workspaceRevision)
  );
}

/** repo.tasks.document.read(daemon.document-read/v2)。内容真相字段是这里的重点:
 * 缺了 contentKind/mediaType/size/bytes/repositoryPath,一份空 `body` 与「这不是文本」
 * 无法区分,PDF 就会被渲染成一张白页。 */
export function isTaskDocumentRead(value: unknown): boolean {
  return (
    isRendererRecord(value) &&
    value.ok === true &&
    (value.status === "ready" || value.status === "pending") &&
    typeof value.taskId === "string" &&
    typeof value.path === "string" &&
    typeof value.body === "string" &&
    (value.contentKind === "text" || value.contentKind === "binary") &&
    (value.mediaType === null || typeof value.mediaType === "string") &&
    (value.size === null || Number.isSafeInteger(value.size)) &&
    (value.bytes === null || typeof value.bytes === "string") &&
    typeof value.repositoryPath === "string" &&
    (value.worktreeBody === null || typeof value.worktreeBody === "string") &&
    typeof value.uncommitted === "boolean" &&
    Number.isSafeInteger(value.watermark) &&
    Number.isSafeInteger(value.sourceRevision)
  );
}
