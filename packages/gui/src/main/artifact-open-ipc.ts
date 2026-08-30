import { statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "../../../kernel/src/index.ts";
import {
  ARTIFACT_OPEN_EXTERNAL_CHANNEL,
  type ArtifactOpenExternalInput,
  type ArtifactOpenExternalResult,
} from "../api/artifact-open-contract.ts";
import { consumeKnownError } from "../api/error-consumption.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

/**
 * 「在默认浏览器打开」的唯一 IPC 通道(task_7e713fee)。
 *
 * 收窄三道，缺一不可:
 *   1. 只接受 `{repoId, path}` 里的 repo 相对产物路径，且路径形状必须是
 *      `tasks/<package>/artifacts/<…>`，段内不得出现 `..`/`.`/反斜杠/控制字符，
 *      扩展名只认 html/htm/md —— 渲染进程提不出任意路径。
 *   2. 绝对路径由主进程解析:repoId → 已注册仓库的 canonical root(daemon registry
 *      是唯一事实源)，再经 kernel 的 resolveHarnessLayout 取该仓 harness 目录，
 *      与 daemon artifacts 读侧同一条布局判定。
 *   3. 解析结果必须落在 harness 目录之内且是真实文件，才交给 openPath。
 *
 * electron 的 shell 不在本模块引入（那会让 node 环境的单元测试无法加载），
 * 由 electron-main 作为 openPath 服务注入。
 */

export interface ArtifactOpenServices {
  /** repoId → 已注册仓库的 canonical root;未注册/被禁用时抛错。 */
  readonly canonicalRootOf: (repoId: string) => string;
  /** 交给系统打开的通路(electron-main 注入 shell.openPath)。返回空串 = 成功。 */
  readonly openPath: (absolutePath: string) => Promise<string>;
  /** 可注入的布局解析;缺省用 kernel 的 resolveHarnessLayout。 */
  readonly harnessRootOf?: (canonicalRoot: string) => string;
}

export interface ArtifactOpenRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: { readonly sender: { readonly id: number } }, payload: unknown) => Promise<unknown>,
  ) => void;
}

export function registerArtifactOpenIpc(
  registrar: ArtifactOpenRegistrar,
  services: ArtifactOpenServices,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(ARTIFACT_OPEN_EXTERNAL_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const input = validateArtifactOpenExternalInput(payload);
    const canonicalRoot = services.canonicalRootOf(input.repoId);
    const harnessRoot =
      services.harnessRootOf !== undefined ? services.harnessRootOf(canonicalRoot) : defaultHarnessRoot(canonicalRoot);
    const absolute = resolveArtifactAbsolutePath(harnessRoot, input.path);
    const failure = await services.openPath(absolute);
    if (failure !== "") throw new Error(`Opening ${absolute} in the system viewer failed: ${failure}`);
    const result: ArtifactOpenExternalResult = { ok: true, openedPath: absolute, error: null };
    return result;
  });
}

export function validateArtifactOpenExternalInput(value: unknown): ArtifactOpenExternalInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Artifact open requires an object payload.");
  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "repoId" && key !== "path") throw new Error(`Artifact open does not accept field ${key}.`);
  const repoId = record.repoId;
  if (typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId))
    throw new Error("Artifact open requires a registered repo id.");
  return { repoId, path: requireArtifactRelativePath(record.path) };
}

/** repo 相对产物路径:必须是 `tasks/<package>/artifacts/…`，段内禁 `..`/`.`/分隔符逃逸。 */
export function requireArtifactRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Artifact open requires an artifact path string.");
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("Artifact path contains unsupported characters.");
  if (value.startsWith("/") || /^[a-zA-Z]:/u.test(value)) throw new Error("Artifact path must be repo-relative.");
  const segments = value.split("/");
  if (segments.length < 4 || segments[0] !== "tasks" || segments[2] !== "artifacts")
    throw new Error("Artifact path must point inside a task package artifacts/ tree.");
  for (const segment of segments)
    if (segment.length === 0 || segment === "." || segment === "..")
      throw new Error("Artifact path must not contain relative or empty segments.");
  if (!/\.(?:html|htm|md)$/iu.test(value)) throw new Error("Artifact path must be an html or markdown file.");
  return value;
}

function defaultHarnessRoot(canonicalRoot: string): string {
  // tasksRoot 即 daemon artifacts 读侧的同一布局判定;harness 目录是它的父目录。
  return path.dirname(resolveHarnessLayout(canonicalRoot).tasksRoot);
}

/** 绝对化 + 逃逸校验:解析结果必须仍在 harness 目录之内，且是真实文件。 */
export function resolveArtifactAbsolutePath(harnessRoot: string, relativePath: string): string {
  const root = path.resolve(harnessRoot);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
    throw new Error("Artifact path escapes the repository harness directory.");
  let isFile = false;
  try {
    isFile = statSync(absolute).isFile();
  } catch (cause) {
    // ENOENT/权限不可读都归到同一条「盘上没有这个文件」的拒绝上。
    consumeKnownError(cause);
  }
  if (isFile !== true) throw new Error(`Artifact file is not present on disk: ${absolute}`);
  return absolute;
}
