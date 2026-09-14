export const LOCAL_DOC_READ_CHANNEL = "harness:localDoc:read";
export const LOCAL_DOC_WRITE_CHANNEL = "harness:localDoc:write";

/**
 * 「GUI 内读本机文档」(task_89d324b5)与「写回本机文档」(task_5dfe382f)的 renderer→main 契约。
 *
 * 详情页 Markdown 里的本机文件链接(项目外绝对路径 / `~/…`)在 GUI 内打开阅读,
 * SkillEditorModal 把编辑后的 `SKILL.md` 写回磁盘:两者都是节点本地操作 —— 主进程用
 * node:fs 直接读写一个文件,不落台账、无并发主体。操作者是本机合作者,因此不做
 * allowlist 配置层、不对敏感目录特判:本机当前用户可读写的文件即可读写。
 *
 * 伪装防线只有一条且是诚实展示:路径在主进程解析符号链接后返回**真实绝对路径**
 * (realpath),界面按它展示 —— 链接写 `/tmp/link.md` 而真身在 `~/Notes/x.md` 时,
 * 读者看到的是真身路径。不可读/不可写(不存在/无权限/目录/二进制/超大)以 typed
 * code 返回,渲染进程按 code 出页内错误态,绝不抛成白屏。
 */
export type LocalDocReadErrorCode =
  | "not_found"
  | "not_a_regular_file"
  | "not_readable"
  | "binary_file"
  | "too_large"
  | "request_rejected"
  | "bridge_unavailable";

export interface LocalDocReadInput {
  /** Markdown href 原样路径:绝对路径(`/Users/…`)或家目录相对(`~/…`)。 */
  readonly path: string;
}

export interface LocalDocReadSuccess {
  readonly ok: true;
  /** realpath 解析后的真实绝对路径(符号链接已展开),界面按它展示。 */
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface LocalDocReadFailure {
  readonly ok: false;
  readonly code: LocalDocReadErrorCode;
  readonly path: string;
  readonly message: string;
}

export type LocalDocReadResult = LocalDocReadSuccess | LocalDocReadFailure;

/**
 * 「GUI 内写回本机文档」(task_5dfe382f)的 renderer→main 契约:SkillEditorModal 把
 * 编辑后的 `SKILL.md` 写回磁盘。同读通道一样是节点本地操作 —— 操作者是本机合作者,
 * 主进程只校验形状与路径、拒绝目录伪装与超限内容,然后落盘;不落台账、无并发主体。
 */
export type LocalDocWriteErrorCode =
  | "not_found"
  | "not_a_regular_file"
  | "not_writable"
  | "request_rejected"
  | "bridge_unavailable"
  | "too_large";

export interface LocalDocWriteInput {
  /** 目标文件路径:绝对路径(`/Users/…`)或家目录相对(`~/…`);通常是已存在的 SKILL.md。 */
  readonly path: string;
  /** 完整文件内容(整体覆盖写,非增量)。 */
  readonly content: string;
}

export interface LocalDocWriteSuccess {
  readonly ok: true;
  /** realpath 解析后的真实绝对路径(符号链接已展开)。 */
  readonly path: string;
  readonly sizeBytes: number;
}

export interface LocalDocWriteFailure {
  readonly ok: false;
  readonly code: LocalDocWriteErrorCode;
  readonly path: string;
  readonly message: string;
}

export type LocalDocWriteResult = LocalDocWriteSuccess | LocalDocWriteFailure;

export interface LocalDocApi {
  readonly read: (input: LocalDocReadInput) => Promise<LocalDocReadResult>;
  readonly write: (input: LocalDocWriteInput) => Promise<LocalDocWriteResult>;
}
