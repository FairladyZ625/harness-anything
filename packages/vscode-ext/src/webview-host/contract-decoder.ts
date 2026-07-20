import {
  decodeRendererSafeConnectionState,
  type RendererSafeStateDecoder
} from "@harness-anything/api-contracts/renderer-safe-state";

export const decodeWebviewConnectionState = decodeRendererSafeConnectionState satisfies RendererSafeStateDecoder;
