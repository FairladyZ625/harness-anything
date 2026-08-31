export const ARTIFACT_OPEN_EXTERNAL_CHANNEL = "harness:artifacts:openExternal";

/**
 * 「在默认浏览器打开」(task_7e713fee)的 renderer→main 契约。
 *
 * 渲染进程只报 daemon 已经报出的那条 repo 相对产物路径(`tasks/<package>/artifacts/…`),
 * 不报绝对路径 —— 绝对路径由主进程从已注册仓库的 canonical root 解析,渲染进程
 * 因此从一开始就提不出「打开任意路径」这一请求形态。主进程侧的收窄见
 * main/artifact-open-ipc.ts。
 */
export interface ArtifactOpenExternalInput {
  readonly repoId: string;
  readonly path: string;
}

export interface ArtifactOpenExternalResult {
  readonly ok: boolean;
  readonly openedPath: string;
  readonly error: string | null;
}

export interface ArtifactOpenApi {
  readonly openExternal: (input: ArtifactOpenExternalInput) => Promise<ArtifactOpenExternalResult>;
}
