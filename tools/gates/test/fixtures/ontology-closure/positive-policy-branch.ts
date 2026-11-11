export function nextAttempt(retryCount: number) {
  if (retryCount > 3) return "deny";
  return "retry";
}
