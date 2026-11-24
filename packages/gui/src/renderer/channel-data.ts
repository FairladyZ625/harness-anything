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

function parseChannelListEvidence(evidence: string | undefined): ChannelListSuccess {
  if (!evidence) return { ok: true, items: [], nextCursor: null, watermark: 0 };
  try {
    const parsed = JSON.parse(evidence) as {
      items?: ChannelListItem[];
      nextCursor?: string | null;
      watermark?: number;
    };
    return {
      ok: true,
      items: parsed.items ?? [],
      nextCursor: parsed.nextCursor ?? null,
      watermark: parsed.watermark ?? 0,
    };
  } catch {
    return { ok: true, items: [], nextCursor: null, watermark: 0 };
  }
}

function channelReceipt(value: unknown) {
  const receipt = readGuiActionResult(value);
  if (
    !receipt.ok ||
    receipt.outcome === "op_rejected" ||
    receipt.outcome === "indeterminate" ||
    receipt.outcome === "pending"
  )
    throw new Error(receipt.hint ?? receipt.outcome ?? "Channel request did not complete.");
  return receipt;
}

export async function readChannelList(repoId: string, channelKind?: string): Promise<ChannelListSuccess> {
  const params = { repoId, ...(channelKind ? { channelKind } : {}) };
  const receipt = channelReceipt(await invoke("repo.channel.list", params));
  return parseChannelListEvidence(receipt.evidence);
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
      repoId: payload.repoId,
      requestId: payload.requestId,
      claim: payload.claim,
      requestedAction: payload.requestedAction,
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
      repoId: payload.repoId,
      requestId: payload.requestId,
      work: payload.work,
      ...(payload.title ? { title: payload.title } : {}),
    }),
  );
}

export function useInvalidateChannel(repoId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: channelQueryKeys.all(repoId) });
}