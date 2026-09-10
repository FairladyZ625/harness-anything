import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
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
 *      文件名必须命中 OPENABLE_ARTIFACT_NAME 白名单(prose 集 + 只被呈现的 raw 产物)
 *      —— 渲染进程提不出任意路径,也提不出可执行名。
 *   2. 绝对路径由主进程解析:local 仓 repoId → 已注册仓库的 canonical root(daemon registry
 *      是唯一事实源)，再经 kernel 的 resolveHarnessLayout 取该仓 harness 目录，
 *      与 daemon artifacts 读侧同一条布局判定。remote-proxy 仓本机无文件,改走
 *      daemon `repo.tasks.document.read` 取正文或 canonical 字节,物化只读副本到
 *      `<userRoot>/artifact-cache/<repoId>/<sha>/<basename>` 后交给 openPath(§3.4 统一面)。
 *   3. 解析结果必须落在 harness 目录之内(local)且是真实文件;物化副本必须落在
 *      artifact-cache 之内,才交给 openPath。
 *
 * electron 的 shell 不在本模块引入（那会让 node 环境的单元测试无法加载），
 * 由 electron-main 作为 openPath 服务注入。
 */

export interface ArtifactOpenServices {
  /** repoId → 已注册仓库的 canonical root;未注册/被禁用时抛错。 */
  readonly canonicalRootOf: (repoId: string) => string;
  /** repoId → registry v2 的模式;remote-proxy 仓走物化副本路径。 */
  readonly repoModeOf: (repoId: string) => string | null;
  /** 经 daemon 读产物正文(remote-proxy 物化副本的数据源);返回 {ok:false} 形态失败。
   * `bytes` 是 raw 产物的 canonical 字节(base64);非文本产物只认它,不认正文串。
   * `contentKind`/`size`/`repositoryPath` 是二进制产物的内容真相:超过内联上限时
   * bytes 为 null,而它的正文本来就是空串,必须据此拒绝而不是物化一个 0 字节副本。 */
  readonly readDocument: (
    repoId: string,
    taskId: string,
    artifactPath: string,
  ) => Promise<{
    readonly body: string | null;
    readonly worktreeBody: string | null;
    readonly uncommitted: boolean;
    readonly bytes: string | null;
    readonly contentKind: "text" | "binary";
    readonly size: number | null;
    readonly repositoryPath: string | null;
  }>;
  /** 物化副本根目录(`<userRoot>/artifact-cache`);repoId 子目录由本模块追加。 */
  readonly artifactCacheRoot: () => string;
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
    const opened =
      services.repoModeOf(input.repoId) === "remote-proxy"
        ? await openMaterializedCopy(services, input)
        : await openLocalFile(services, input);
    return opened;
  });
}

async function openLocalFile(
  services: ArtifactOpenServices,
  input: ArtifactOpenExternalInput,
): Promise<ArtifactOpenExternalResult> {
  const canonicalRoot = services.canonicalRootOf(input.repoId);
  const harnessRoot =
    services.harnessRootOf !== undefined ? services.harnessRootOf(canonicalRoot) : defaultHarnessRoot(canonicalRoot);
  const absolute = resolveArtifactAbsolutePath(harnessRoot, input.path);
  const failureMessage = await services.openPath(absolute);
  if (failureMessage !== "") throw new Error(`Opening ${absolute} in the system viewer failed: ${failureMessage}`);
  return { ok: true, openedPath: absolute, error: null };
}

/** remote-proxy 的统一面:daemon 正文 → 只读副本 → openPath;local 模式不走这里。 */
async function openMaterializedCopy(
  services: ArtifactOpenServices,
  input: ArtifactOpenExternalInput,
): Promise<ArtifactOpenExternalResult> {
  if (input.taskId === undefined || input.taskId.length === 0)
    throw new Error("Opening an artifact of a remote-proxy repository requires its task id.");
  const document = await services.readDocument(input.repoId, input.taskId, input.path);
  // 二进制产物的正文是空串——那是策略,不是文件为空。超过内联上限时 bytes 为 null,
  // 落到正文分支就会写出一个同名的 0 字节文件并报成功:查看器打开一张白页,而调用方
  // 拿到的是 ok:true。这里必须停在明确的失败上,并说出去哪里取这份字节。
  if (document.contentKind === "binary" && document.bytes === null)
    throw new Error(
      `${input.path} is a binary artifact of ${document.size ?? "unknown"} bytes; its canonical bytes are above the ` +
        `inline read ceiling, so open it from ${document.repositoryPath ?? "the repository host"} instead.`,
    );
  // 非文本产物没有正文:字节来自 canonical content object。把 UTF-8 重编码写成副本
  // 会交给查看器一个同名的不同文件,所以 bytes 在时一律以 bytes 为准。
  const content =
    document.bytes !== null
      ? Buffer.from(document.bytes, "base64")
      : materializedText(
          document.uncommitted && document.worktreeBody !== null ? document.worktreeBody : document.body,
        );
  if (content === null) throw new Error(`The remote repository does not have the artifact body for ${input.path}.`);
  const sha = createHash("sha256").update(content).digest("hex"),
    directory = path.join(services.artifactCacheRoot(), input.repoId, sha),
    copyPath = path.join(directory, artifactBasename(input.path));
  mkdirSync(directory, { recursive: true });
  if (!isRegularFile(copyPath)) writeFileSync(copyPath, content, { mode: 0o444 });
  const failureMessage = await services.openPath(copyPath);
  if (failureMessage !== "") throw new Error(`Opening ${copyPath} in the system viewer failed: ${failureMessage}`);
  return { ok: true, openedPath: copyPath, error: null };
}

export function validateArtifactOpenExternalInput(value: unknown): ArtifactOpenExternalInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Artifact open requires an object payload.");
  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "repoId" && key !== "path" && key !== "taskId")
      throw new Error(`Artifact open does not accept field ${key}.`);
  const repoId = record.repoId;
  if (typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId))
    throw new Error("Artifact open requires a registered repo id.");
  if (record.taskId !== undefined && (typeof record.taskId !== "string" || record.taskId.length === 0))
    throw new Error("Artifact open taskId must be a non-empty string.");
  return {
    repoId,
    path: requireArtifactRelativePath(record.path),
    ...(record.taskId !== undefined ? { taskId: record.taskId as string } : {}),
  };
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
  if (!OPENABLE_ARTIFACT_NAME.test(value)) throw new Error("Artifact path must be an openable artifact file.");
  return value;
}

/** 系统查看器只接这些名字:html/htm/md 是原有的 prose 集,其余是查看器会「呈现」而不会
 * 「执行」的 raw 任务产物。可执行名(.sh/.exe/.command)与浏览器会跑脚本的 .svg 一律不进,
 * 它们由读侧回答真实元数据与 repositoryPath,而不是交给 openPath。 */
const OPENABLE_ARTIFACT_NAME = /\.(?:html|htm|md|txt|log|csv|json|pdf|png|jpe?g|gif|webp|bmp)$/iu;

function materializedText(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, "utf8");
}

/** 物化副本的文件名:产物路径的末段(路径已过 requireArtifactRelativePath 的段校验)。 */
export function artifactBasename(artifactPath: string): string {
  const segments = artifactPath.split("/"),
    name = segments[segments.length - 1] ?? "";
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\"))
    throw new Error("Artifact path must end in a plain file name.");
  return name;
}

function isRegularFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch (cause) {
    consumeKnownError(cause);
    return false;
  }
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
