// JSON-RPC line framing shared by the protocol server and the transport. The server may encode a
// response once, then hand the same bytes to the transport; this keeps reply-size accounting exact
// without serializing every result twice on the hot path.
const preEncodedFrame = Symbol("harness.jsonRpcPreEncodedFrame");

export function encodeJsonRpcFrame(frame: unknown): string {
  const direct = preEncodedOf(frame);
  if (direct !== null) return direct;
  if (Array.isArray(frame)) {
    const encoded = frame.map((item) => preEncodedOf(item));
    if (encoded.every((item): item is string => item !== null))
      return `[${encoded.map((item) => item.trimEnd()).join(",")}]\n`;
  }
  return `${JSON.stringify(frame)}\n`;
}

export function attachEncodedJsonRpcFrame<T extends object>(frame: T, encoded: string): T {
  Object.defineProperty(frame, preEncodedFrame, { value: encoded, enumerable: false, configurable: false });
  return frame;
}

/** Exact encoded byte length of a frame, counting UTF-8 bytes and the trailing newline. */
export function encodedFrameBytes(encoded: string): number {
  return Buffer.byteLength(encoded);
}

function preEncodedOf(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const encoded = (frame as { readonly [preEncodedFrame]?: unknown })[preEncodedFrame];
  return typeof encoded === "string" ? encoded : null;
}
