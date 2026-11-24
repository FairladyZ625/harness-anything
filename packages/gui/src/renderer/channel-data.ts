import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./api-client-invoke.ts";
import { readGuiActionResult } from "./command-receipt.ts";
import type { GuiActionResult } from "../api/renderer-dto.ts";

export interface ChannelListItem {
  readonly itemId: string;
  readonly channelKind: string;
  readonly direction: string;
  readonly summary: string;
  readonly status: string;
  readonly principalPersonId: string;
  readonly senderRef?: string;
  readonly recipientRef?: string;
  readonly correlationId?: string;
  readonly peerRequestId?: string;
  readonly inboxItemId?: string;
  readonly deliveredAt: string;
}

export interface ChannelListSuccess {
  readonly ok: true;
  readonly items: readonly ChannelListItem[];
  readonly nextCursor: string | null;
  readonly watermark: number;
}

export const channelQueryKeys = {
  all: (repoId: string) => ["channel", repoId] as const,
  list: (repoId: string, channelKind?: string) => [...channelQueryKeys.all(repoId), "list", channelKind] as const,
};

function readChannelListResult(value: unknown): ChannelListSuccess {
  if (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: boolean }).ok === true &&
    "items" in value
  ) {
    const v = value as { items: ChannelListItem[]; nextCursor?: string | null; watermark?: number };
    return { ok: true, items: v.items ?? [], nextCursor: v.nextCursor ?? null, watermark: v.watermark ?? 0 };
  }
  if (typeof value === "object" && value !== null && "evidence" in value) {
    try {
      const evidence = JSON.parse(String((value as { evidence: string }).evidence));
      return {
        ok: true,
        items: evidence.items ?? [],
        nextCursor: evidence.nextCursor ?? null,
        watermark: evidence.watermark ?? 0,
      };
    } catch {
      return { ok: true, items: [], nextCursor: null, watermark: 0 };
    }
  }
  return { ok: true, items: [], nextCursor: null, watermark: 0 };
}

export async function readChannelList(repoId: string, channelKind?: string): Promise<ChannelListSuccess> {
  const payload = { repo: { repoId }, payload: { ...(channelKind ? { channelKind } : {}) } };
  const result = await invoke("repo.channel.list", payload);
  return readChannelListResult(result);
}

export function useChannelListQuery(repoId: string, channelKind?: string) {
  return useQuery({
    queryKey: channelQueryKeys.list(repoId, channelKind),
    queryFn: () => readChannelList(repoId, channelKind),
    enabled: repoId.length > 0,
  });
}

export async function replyPeerRequest(payload: {
  readonly repoId: string;
  readonly requestId: string;
  readonly claim: string;
  readonly requestedAction: string;
}): Promise<GuiActionResult> {
  return readGuiActionResult(
    await invoke("repo.peer.reply", {
      repo: { repoId: payload.repoId },
      payload: { requestId: payload.requestId, claim: payload.claim, requestedAction: payload.requestedAction },
    }),
  );
}

export async function promotePeerRequest(payload: {
  readonly repoId: string;
  readonly requestId: string;
  readonly work: string;
  readonly title?: string;
}): Promise<GuiActionResult> {
  return readGuiActionResult(
    await invoke("repo.peer.promote", {
      repo: { repoId: payload.repoId },
      payload: { requestId: payload.requestId, work: payload.work, ...(payload.title ? { title: payload.title } : {}) },
    }),
  );
}

export function useInvalidateChannel(repoId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: channelQueryKeys.all(repoId) });
}