import type { RendererSafeConnectionState } from "@harness-anything/api-contracts";

export interface HostToWebviewMessage {
  readonly kind: "connection-state";
  readonly value: RendererSafeConnectionState;
}
