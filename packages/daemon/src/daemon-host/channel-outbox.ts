import type { ChannelOutboxMessage } from "@harness-anything/kernel/internal/domain/channel-adapter.ts";
import {
  resolveBuiltinChannelOutboundAdapter,
  type ChannelOutboundAdapter,
  type ChannelOutboundDispatchResult,
} from "@harness-anything/application/internal/commands/channel-outbox.ts";

export type { ChannelOutboundAdapter } from "@harness-anything/application/internal/commands/channel-outbox.ts";

const repoOutboundAdapters = new Map<string, ChannelOutboundAdapter[]>();

/** Mount an external/custom outbound adapter for a repository without coupling IM SDKs into the kernel. */
export function registerChannelOutboundAdapter(repoId: string, adapter: ChannelOutboundAdapter): () => void {
  const current = repoOutboundAdapters.get(repoId) ?? [];
  const next = [...current.filter((entry) => entry.id !== adapter.id), adapter];
  repoOutboundAdapters.set(repoId, next);
  return () => {
    const existing = repoOutboundAdapters.get(repoId);
    if (!existing) return;
    const remaining = existing.filter((entry) => entry.id !== adapter.id);
    if (remaining.length === 0) repoOutboundAdapters.delete(repoId);
    else repoOutboundAdapters.set(repoId, remaining);
  };
}

export type ChannelOutboundBridge = (request: {
  readonly op: "has" | "deliver";
  readonly message: ChannelOutboxMessage;
  readonly now: string;
}) => boolean | ChannelOutboundDispatchResult;

export function resolveCustomChannelOutboundAdapter(
  repoId: string,
  message: ChannelOutboxMessage,
): ChannelOutboundAdapter | undefined {
  const custom = repoOutboundAdapters.get(repoId) ?? [];
  for (let i = custom.length - 1; i >= 0; i -= 1) {
    const adapter = custom[i]!;
    if (adapter.channelKind === message.channelKind && adapter.matches(message)) return adapter;
  }
  return undefined;
}

export function resolveChannelOutboundAdapter(
  repoId: string,
  message: ChannelOutboxMessage,
  bridge?: ChannelOutboundBridge,
): ChannelOutboundAdapter | undefined {
  const local = resolveCustomChannelOutboundAdapter(repoId, message);
  if (local) return local;
  if (bridge && bridge({ op: "has", message, now: "" }) === true) {
    return {
      id: "host:channel-outbound-bridge",
      channelKind: message.channelKind,
      matches: () => true,
      deliver: (msg, context) =>
        bridge({ op: "deliver", message: msg, now: context.now }) as ChannelOutboundDispatchResult,
    };
  }
  return resolveBuiltinChannelOutboundAdapter(message);
}
