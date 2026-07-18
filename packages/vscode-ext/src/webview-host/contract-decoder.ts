import {
  decodeRendererSafeConnectionState,
  type RendererSafeStateDecoder
} from "../../../api-contracts/src/renderer-safe-state.ts";

export const decodeWebviewConnectionState = decodeRendererSafeConnectionState satisfies RendererSafeStateDecoder;
