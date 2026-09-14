import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  LOCAL_DOC_READ_CHANNEL,
  LOCAL_DOC_WRITE_CHANNEL,
  type LocalDocReadInput,
  type LocalDocReadResult,
  type LocalDocWriteInput,
  type LocalDocWriteResult,
  type LocalDocWriteFailure,
} from "../api/local-doc-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

/**
 * 「GUI 内读本机文档」(task_89d324b5)与「写回本机文档」(task_5dfe382f)的唯一 IPC 通道。
 *
 * 详情页 Markdown 链接指向项目外本机文件时,渲染进程把链接里的路径原样交给读通道,
 * 主进程只做只读解析与读取;SkillEditorModal 把编辑后的 SKILL.md 整体交给写通道落盘。
 * 两者共用同一套请求形状收紧与 typed 失败:
 *
 *   1. 请求形状收紧:读 `{path}`、写 `{path, content}` 且恰为这些字段;路径必须是
 *      非空、无控制字符的字符串,`~` 展开后必须是绝对路径 —— 相对路径与 `~user`
 *      形态在入口即拒。
 *   2. 符号链接在读写前用 realpath 展开,返回真实绝对路径:界面展示真身路径,
 *      目录逃逸伪装(链接写 A、真身在 B)在展示层不成立;写路同样写真身。
 *   3. 边界:不落台账;操作者是本机合作者,本机当前用户可读写的文件即可读写,
 *      无 allowlist、无敏感目录特判;新文件只允许落在已存在的目录里。
 *   4. 失败 typed:fs errno(`error.code`)键控映射到契约 code,渲染进程按 code
 *      出页内错误态;二进制(NUL/高替换率)与超过上限的文件同样 typed 拒绝。
 *
 * electron 不在本模块引入(node 单测要能加载),home 目录由默认服务提供、可注入。
 */

/** 单文件读写上限:按「一篇文档」设定,超限给页内错误而非卡死渲染或吞掉超大写入。 */
export const LOCAL_DOC_MAX_BYTES = 2 * 1024 * 1024;

/** 二进制嗅探窗口:UTF-8 解码后前 4 KiB 内替换字符占比超过该阈值判定为二进制。 */
const BINARY_SNIFF_WINDOW = 4096;
const BINARY_REPLACEMENT_RATIO = 0.1;

export interface LocalDocServices {
  /** `~` 展开的根;缺省 node:os homedir()。 */
  readonly homeDir: () => string;
  /** 读取上限(字节);缺省 LOCAL_DOC_MAX_BYTES。 */
  readonly maxBytes?: number;
}

export interface LocalDocRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: { readonly sender: { readonly id: number } }, payload: unknown) => Promise<unknown>,
  ) => void;
}

export function registerLocalDocIpc(
  registrar: LocalDocRegistrar,
  services: LocalDocServices = { homeDir: homedir },
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(LOCAL_DOC_READ_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const input = validateLocalDocReadInput(payload);
    return readLocalDocument(input.path, services);
  });
  registrar.handle(LOCAL_DOC_WRITE_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    const input = validateLocalDocWriteInput(payload);
    return writeLocalDocument(input.path, input.content, services);
  });
}

export function validateLocalDocReadInput(value: unknown): LocalDocReadInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Local document read requires an object payload.");
  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "path") throw new Error(`Local document read does not accept field ${key}.`);
  return { path: usableLocalDocPath(record.path) };
}

export function validateLocalDocWriteInput(value: unknown): LocalDocWriteInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Local document write requires an object payload.");
  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "path" && key !== "content") throw new Error(`Local document write does not accept field ${key}.`);
  if (typeof record.content !== "string") throw new Error("Local document write requires a content string.");
  return { path: usableLocalDocPath(record.path), content: record.content };
}

/** 读写共用的路径形状收紧:非空字符串、无控制字符、无跨平台非法分隔符。 */
function usableLocalDocPath(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length === 0)
    throw new Error("Local document request requires a path string.");
  if (candidate.length > 4096 || CONTROL_CHARACTERS.test(candidate))
    throw new Error("Local document path contains unsupported characters.");
  // 非 Windows 平台不接受反斜杠与 Windows 盘符形态(与 api/local-api 的
  // isForeignAbsolutePath 同一口径);Windows 上反斜杠是合法分隔符。注意不能用
  // path.win32.isAbsolute 判盘符 —— 它对 `/posix/abs` 也返回 true。
  if (process.platform !== "win32" && (candidate.includes(BACKSLASH) || WINDOWS_DRIVE.test(candidate)))
    throw new Error("Local document path uses an unsupported separator.");
  return candidate;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** `~/…` → `<home>/…`;`~user` 不展开(交给后续绝对路径判定拒绝)。 */
export function expandHomePath(inputPath: string, homeDir: string): string {
  if (inputPath === "~") return homeDir;
  if (inputPath.startsWith("~/")) return path.join(homeDir, inputPath.slice(2));
  return inputPath;
}

/** fs errno → 契约 code(code 键控,不做消息子串判定)。 */
export function classifyLocalDocFsError(cause: unknown): "not_found" | "not_a_regular_file" | "not_readable" {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "not_found";
  if (code === "EISDIR") return "not_a_regular_file";
  return "not_readable";
}

/** 写路同款映射:权限/IO 类失败折叠为 `not_writable`,其余与读路一致。 */
function classifyLocalDocWriteFsError(cause: unknown): Extract<LocalDocWriteResult, { readonly ok: false }>["code"] {
  const readCode = classifyLocalDocFsError(cause);
  return readCode === "not_readable" ? "not_writable" : readCode;
}

/** UTF-8 安全解码后的二进制嗅探:NUL 字节,或嗅探窗口内替换字符占比过高。 */
export function looksBinary(content: string): boolean {
  if (content.includes(NUL)) return true;
  const head = content.slice(0, BINARY_SNIFF_WINDOW);
  if (head.length === 0) return false;
  let replacements = 0;
  for (const character of head) if (character === REPLACEMENT_CHARACTER) replacements += 1;
  return replacements / head.length > BINARY_REPLACEMENT_RATIO;
}

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(0x5c);
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/u;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export async function readLocalDocument(
  rawPath: string,
  services: LocalDocServices = { homeDir: homedir },
): Promise<LocalDocReadResult> {
  const maxBytes = services.maxBytes ?? LOCAL_DOC_MAX_BYTES;
  const expanded = expandHomePath(rawPath, services.homeDir());
  if (!path.isAbsolute(expanded))
    return {
      ok: false,
      code: "request_rejected",
      path: expanded,
      message: "Local document path must be absolute after home-directory expansion.",
    };

  let realPath: string;
  try {
    realPath = await realpath(expanded);
  } catch (cause) {
    return fsFailure(classifyLocalDocFsError(cause), expanded, cause);
  }

  let size: number, isFile: boolean;
  try {
    const info = await stat(realPath);
    size = info.size;
    isFile = info.isFile();
  } catch (cause) {
    return fsFailure(classifyLocalDocFsError(cause), realPath, cause);
  }
  if (!isFile)
    return {
      ok: false,
      code: "not_a_regular_file",
      path: realPath,
      message: "Local document path points at a directory or a special file.",
    };
  if (size > maxBytes)
    return {
      ok: false,
      code: "too_large",
      path: realPath,
      message: `Local document is ${size} bytes; the in-app reader accepts at most ${maxBytes}.`,
    };

  let content: string;
  try {
    content = await readFile(realPath, "utf8");
  } catch (cause) {
    return fsFailure(classifyLocalDocFsError(cause), realPath, cause);
  }
  if (looksBinary(content))
    return {
      ok: false,
      code: "binary_file",
      path: realPath,
      message: "Local document does not decode as text.",
    };
  return { ok: true, path: realPath, content, sizeBytes: size };
}

type WriteTargetResolution =
  | { readonly ok: true; readonly realPath: string; readonly exists: boolean }
  | Extract<LocalDocWriteResult, { readonly ok: false }>;

/** 目标已存在:realpath 展开真身;不存在(ENOENT)转交父目录锚定。 */
async function resolveWriteTarget(expanded: string): Promise<WriteTargetResolution> {
  try {
    return { ok: true, realPath: await realpath(expanded), exists: true };
  } catch (cause) {
    if ((cause as { readonly code?: unknown } | null)?.code === "ENOENT")
      return anchorNewFileToExistingParent(expanded);
    return writeFailure(classifyLocalDocWriteFsError(cause), expanded, cause);
  }
}

/** 新文件只允许落在已存在的目录里(parent realpath 锚定),绝不创建中间目录。 */
async function anchorNewFileToExistingParent(expanded: string): Promise<WriteTargetResolution> {
  try {
    const parentReal = await realpath(path.dirname(expanded));
    if (!(await stat(parentReal)).isDirectory())
      return writeFailure("not_found", expanded, new Error("parent path is not a directory"));
    return { ok: true, realPath: path.join(parentReal, path.basename(expanded)), exists: false };
  } catch (parentCause) {
    return writeFailure(classifyLocalDocWriteFsError(parentCause), expanded, parentCause);
  }
}

/**
 * 「GUI 内写回本机文档」(task_5dfe382f):SkillEditorModal 的保存落点。与读路同一套
 * 收紧 —— 路径必须 `~` 展开后为绝对路径;目标存在时必须是常规文件(目录伪装拒绝);
 * 内容超限 typed 拒绝。新文件只允许落在已存在的目录里,写入目标经 realpath 展开,
 * 符号链接写真身。
 */
export async function writeLocalDocument(
  rawPath: string,
  content: string,
  services: LocalDocServices = { homeDir: homedir },
): Promise<LocalDocWriteResult> {
  const maxBytes = services.maxBytes ?? LOCAL_DOC_MAX_BYTES;
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > maxBytes)
    return {
      ok: false,
      code: "too_large",
      path: rawPath,
      message: `Local document write is ${sizeBytes} bytes; the in-app editor accepts at most ${maxBytes}.`,
    };
  const expanded = expandHomePath(rawPath, services.homeDir());
  if (!path.isAbsolute(expanded))
    return {
      ok: false,
      code: "request_rejected",
      path: expanded,
      message: "Local document path must be absolute after home-directory expansion.",
    };

  const target = await resolveWriteTarget(expanded);
  if (!target.ok) return target;
  if (target.exists)
    try {
      if (!(await stat(target.realPath)).isFile())
        return {
          ok: false,
          code: "not_a_regular_file",
          path: target.realPath,
          message: "Local document path points at a directory or a special file.",
        };
    } catch (cause) {
      return writeFailure(classifyLocalDocWriteFsError(cause), target.realPath, cause);
    }

  try {
    await writeFile(target.realPath, content, "utf8");
  } catch (cause) {
    return writeFailure(classifyLocalDocWriteFsError(cause), target.realPath, cause);
  }
  return { ok: true, path: target.realPath, sizeBytes };
}

function writeFailure(
  code: Extract<LocalDocWriteResult, { readonly ok: false }>["code"],
  pathValue: string,
  cause: unknown,
): LocalDocWriteFailure {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, code, path: pathValue, message: detail };
}

function fsFailure(
  code: "not_found" | "not_a_regular_file" | "not_readable",
  pathValue: string,
  cause: unknown,
): LocalDocReadResult {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, code, path: pathValue, message: detail };
}
