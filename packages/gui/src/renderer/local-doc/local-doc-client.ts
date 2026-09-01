import type { LocalDocReadErrorCode, LocalDocReadResult } from "../../api/local-doc-contract.ts";
import { isRendererRecord } from "../result-validation.ts";

/**
 * renderer 侧「GUI 内读本机文档」客户端:把链接里的路径交给 preload 通道
 * (`harness:localDoc:read`),主进程只读解析与读取(main/local-doc-ipc.ts)。
 * 读取失败以 typed `{ok:false, code}` 回来,视图按 code 出页内错误态;
 * 桥不可用 / 主进程拒单同样折叠成 typed 失败,绝不把异常抛进渲染层。
 */
type LocalDocBridge = {
  readonly read: (input: { readonly path: string }) => Promise<unknown>;
};

const bridge = (): LocalDocBridge | null => {
  const value = window.harness as unknown as { readonly localDoc?: LocalDocBridge } | undefined;
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
