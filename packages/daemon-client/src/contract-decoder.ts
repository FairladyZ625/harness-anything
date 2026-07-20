// @slice-activation W-D2 daemon-client contract projection exported for W-D3 host composition.
import {
  decodeRendererSafeConnectionState,
  type RendererSafeStateDecoder
} from "@harness-anything/api-contracts/renderer-safe-state";

export const decodeClientConnectionState = decodeRendererSafeConnectionState satisfies RendererSafeStateDecoder;
