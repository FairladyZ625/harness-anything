// @slice-activation W-D2 daemon-client contract projection exported for W-D3 host composition.
import {
  decodeRendererSafeConnectionState,
  type RendererSafeStateDecoder
} from "../../api-contracts/src/renderer-safe-state.ts";

export const decodeClientConnectionState = decodeRendererSafeConnectionState satisfies RendererSafeStateDecoder;
