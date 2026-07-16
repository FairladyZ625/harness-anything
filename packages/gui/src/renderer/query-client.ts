import { QueryClient } from "@tanstack/react-query";

export const LEDGER_REFRESH_INTERVAL_MS = 10_000;

export function createRendererQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: "always",
        refetchInterval: LEDGER_REFRESH_INTERVAL_MS,
        refetchIntervalInBackground: false,
      },
    },
  });
}
