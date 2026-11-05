/**
 * A one-shot intent, not a session state: the error surface asks the account page to show its
 * existing sign-in flow. The account page consumes the request when it mounts (or while it is
 * already mounted), so navigation and the action survive the same React commit.
 */
let pending = false;
const listeners = new Set<() => void>();

export function requestAccountLogin(): void {
  pending = true;
  for (const listener of listeners) listener();
}

export function consumeAccountLoginRequest(): boolean {
  const requested = pending;
  pending = false;
  return requested;
}

export function subscribeAccountLoginRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: module state must not leak between isolated test cases. */
export function resetAccountLoginRequestForTest(): void {
  pending = false;
  listeners.clear();
}
