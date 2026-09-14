import type {
  LocalDocReadErrorCode,
  LocalDocReadResult,
  LocalDocWriteErrorCode,
  LocalDocWriteResult,
} from "../../api/local-doc-contract.ts";
import { isRendererRecord } from "../result-validation.ts";
import { guiHostBridge } from "../gui-transport.ts";

/**
 * renderer 侧「GUI 内读本机文档 / 写回本机文档」客户端:把链接里的路径交给 preload
 * 读通道(`harness:localDoc:read`),或把编辑后的整体内容交给写通道
 * (`harness:localDoc:write`),主进程收窄见 main/local-doc-ipc.ts。失败以 typed
 * `{ok:false, code}` 回来,视图按 code 出页内错误态;桥不可用 / 主进程拒单同样
 * 折叠成 typed 失败,绝不把异常抛进渲染层。
 */
type LocalDocBridge = {
  readonly read: (input: { readonly path: string }) => Promise<unknown>;
  readonly write: (input: { readonly path: string; readonly content: string }) => Promise<unknown>;
};

const bridge = (): LocalDocBridge | null => {
  const value = guiHostBridge() as unknown as { readonly localDoc?: LocalDocBridge } | undefined;
  return value?.localDoc ?? null;
};

export async function requestLocalDocument(path: string): Promise<LocalDocReadResult> {
  const channel = bridge();
  if (channel === null)
    return {
      ok: false,
      code: "bridge_unavailable",
      path,
      message: "Local document bridge is unavailable.",
    };
  try {
    const value = await channel.read({ path });
    if (isRendererRecord(value)) {
      if (
        value.ok === true &&
        typeof value.path === "string" &&
        typeof value.content === "string" &&
        typeof value.sizeBytes === "number"
      )
        return { ok: true, path: value.path, content: value.content, sizeBytes: value.sizeBytes };
      if (
        value.ok === false &&
        typeof value.code === "string" &&
        typeof value.path === "string" &&
        typeof value.message === "string"
      )
        return { ok: false, code: value.code as LocalDocReadErrorCode, path: value.path, message: value.message };
    }
    return {
      ok: false,
      code: "request_rejected",
      path,
      message: "Local document read returned an unexpected shape.",
    };
  } catch (cause) {
    return {
      ok: false,
      code: "request_rejected",
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function saveLocalDocument(path: string, content: string): Promise<LocalDocWriteResult> {
  const channel = bridge();
  if (channel === null)
    return {
      ok: false,
      code: "bridge_unavailable",
      path,
      message: "Local document bridge is unavailable.",
    };
  try {
    const value = await channel.write({ path, content });
    if (isRendererRecord(value)) {
      if (value.ok === true && typeof value.path === "string" && typeof value.sizeBytes === "number")
        return { ok: true, path: value.path, sizeBytes: value.sizeBytes };
      if (
        value.ok === false &&
        typeof value.code === "string" &&
        typeof value.path === "string" &&
        typeof value.message === "string"
      )
        return { ok: false, code: value.code as LocalDocWriteErrorCode, path: value.path, message: value.message };
    }
    return {
      ok: false,
      code: "request_rejected",
      path,
      message: "Local document write returned an unexpected shape.",
    };
  } catch (cause) {
    return {
      ok: false,
      code: "request_rejected",
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
