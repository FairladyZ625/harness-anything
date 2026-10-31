import {
  EDGE_JOIN_ENTRY_CHANNEL,
  EDGE_JOIN_LINK_CHANNEL,
  type EdgeJoinEntryApi,
} from "@harness-anything/authorization-gui/edge-join-entry-contract";

/**
 * 边缘节点加入向导的 preload 面:join/poll/progress 三条只读请求走同一通道,主进程收窄见
 * main/edge-join-entry-ipc.ts;协议激活(harness-edge:// 链接)由主进程校验后推送。渲染进程
 * 不接触邀请令牌以外的任何凭据,令牌也只在向导的内存状态里停留。
 */
export function edgeJoinEntryPreloadApi(
  invoke: (channel: string, request: unknown) => Promise<unknown>,
  on: (channel: string, listener: (payload: unknown) => void) => () => void,
): EdgeJoinEntryApi {
  return {
    begin: (input) => invoke(EDGE_JOIN_ENTRY_CHANNEL, { kind: "join", link: input.link }),
    poll: () => invoke(EDGE_JOIN_ENTRY_CHANNEL, { kind: "poll" }),
    progress: () => invoke(EDGE_JOIN_ENTRY_CHANNEL, { kind: "progress" }),
    openLogin: () => invoke(EDGE_JOIN_ENTRY_CHANNEL, { kind: "open-login" }),
    onJoinLink: (listener) =>
      on(EDGE_JOIN_LINK_CHANNEL, (payload) => {
        if (typeof payload === "object" && payload !== null && typeof (payload as { link?: unknown }).link === "string")
          listener((payload as { link: string }).link);
      }),
  };
}
