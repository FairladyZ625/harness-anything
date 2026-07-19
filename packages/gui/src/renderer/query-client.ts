import { QueryClient } from "@tanstack/react-query";

export const LEDGER_REFRESH_INTERVAL_MS = 10_000;
let projectionPushActive = false;

export function setProjectionPushActive(active: boolean): void {
  projectionPushActive = active;
}

export function ledgerRefreshInterval(): number | false {
  return projectionPushActive ? false : LEDGER_REFRESH_INTERVAL_MS;
}

export function createRendererQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: "always",
        refetchInterval: ledgerRefreshInterval,
        refetchIntervalInBackground: false,
      },
    },
  });
}
