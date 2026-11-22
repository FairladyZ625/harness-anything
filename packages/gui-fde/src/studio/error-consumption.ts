/** Explicit boundary sink for errors already projected into UI or HTTP/IPC responses. */
export function consumeKnownError(error: unknown): void {
  void error;
}
