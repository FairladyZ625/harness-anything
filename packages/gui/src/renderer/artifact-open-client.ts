import type { ArtifactOpenExternalInput, ArtifactOpenExternalResult } from "../api/artifact-open-contract.ts";
import { isRendererRecord } from "./result-validation.ts";

/**
 * renderer 侧的「在默认浏览器打开」客户端:只把 repo 相对产物路径交给 preload
 * 通道(`harness:artifacts:openExternal`),绝对路径与校验都在主进程
 * (main/artifact-open-ipc.ts)。失败以 `{ok:false, error}` 回来,视图就地显示,
 * 不抛进渲染进程的错误边界。
 */
type ArtifactOpenBridge = {
  readonly openExternal: (input: ArtifactOpenExternalInput) => Promise<unknown>;
};

const bridge = (): ArtifactOpenBridge | null => {
  const value = window.harness as unknown as { readonly artifacts?: ArtifactOpenBridge } | undefined;
  return value?.artifacts ?? null;
};

const FALLBACK: ArtifactOpenExternalResult = {
  ok: false,
  openedPath: "",
  error: "Artifacts open bridge is unavailable.",
};

export async function openArtifactExternally(input: ArtifactOpenExternalInput): Promise<ArtifactOpenExternalResult> {
  const channel = bridge();
  if (channel === null) return FALLBACK;
  try {
    const value = await channel.openExternal(input);
    if (isRendererRecord(value) && value.ok === true && typeof value.openedPath === "string")
      return { ok: true, openedPath: value.openedPath, error: null };
    return FALLBACK;
  } catch (cause) {
    return {
      ok: false,
      openedPath: "",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
