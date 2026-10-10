export function isRendererRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** daemon 拒绝回执(op_rejected,如换版排空的 daemon_stopping、仓库未挂载的 repo_unavailable)
 * 是合法答案而非坏回执:它带 code + rejectionExplanation + error.code,没有 error.hint。
 * 提取链固定为 error.hint → rejectionExplanation → 错误码;三处全空才允许调用方的通用文案,
 * 有说明时错误码作为前缀一并呈现,「invalid receipt」只留给形状真的不合法的值。 */
function rejectionText(value: unknown): string | null {
  if (!isRendererRecord(value)) return null;
  const error = isRendererRecord(value.error) ? value.error : null,
    code = typeof (error?.code ?? value.code) === "string" ? ((error?.code ?? value.code) as string) : null,
    explanation =
      typeof error?.hint === "string" && error.hint.trim() !== ""
        ? error.hint
        : typeof value.rejectionExplanation === "string" && value.rejectionExplanation.trim() !== ""
          ? value.rejectionExplanation
          : null;
  if (explanation !== null) return code === null ? explanation : `${code}: ${explanation}`;
  return code;
}

/** 只从明确失败的结果提取服务端说明;成功结果不消费错误字段。 */
export function localErrorHint(value: unknown, fallback: string): string {
  if (isRendererRecord(value) && value.ok === false) {
    const text = rejectionText(value);
    if (text !== null) return text;
  }
  return fallback;
}

export function rendererErrorHint(value: unknown, fallback: string): string {
  return rejectionText(value) ?? fallback;
}

/** Direct bridge clients retain a rejection code just like the shared invoke client. */
export function rendererReadError(value: unknown, fallback: string): Error {
  const error = new Error(localErrorHint(value, rendererErrorHint(value, fallback)));
  if (!isRendererRecord(value) || value.ok !== false) return error;
  const code = isRendererRecord(value.error) ? (value.error.code ?? value.code) : value.code;
  return typeof code === "string" ? Object.assign(error, { code }) : error;
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
