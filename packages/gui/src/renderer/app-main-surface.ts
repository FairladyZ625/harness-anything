import type { ViewId } from "./navigation/viewHistory.ts";

/**
 * Which main surface owns the content viewport. The account recovery surface is reachable even
 * when another repository read is unavailable: the ledger failure strip and its sign-in action
 * must not hide the page that can start the one login flow.
 */
export type AppMainSurface = "account" | "ledger-unavailable" | "default";

export function appMainSurface(view: ViewId, ledgerUnavailable: boolean): AppMainSurface {
  if (view === "identityAccess") return "account";
  return ledgerUnavailable ? "ledger-unavailable" : "default";
}
