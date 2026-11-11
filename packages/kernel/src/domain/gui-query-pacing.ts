import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

export const guiQueryPacing = {
  id: "gui-query-pacing",
  ownerRef: "host",
  unit: "milliseconds / retry count / focus refetch mode",
  bounds: "Ledger probe and daemon-level reads poll every 10s, connections every 30s; retry once.",
  defaultValue: {
    intervals: {
      ledgerProbe: 10_000,
      systemStatus: 10_000,
      connectionStatus: 30_000,
      edgeJoinStatus: 10_000,
      tokenUsage: 10_000,
      fleetOverview: 10_000,
    },
    ledgerProbeFocusRefetch: "always",
    queryDefaults: { queries: { retry: 1, refetchOnWindowFocus: false } },
  },
  version: 1,
  scope: "Desktop QueryClient defaults and daemon read queries",
  reason:
    "The ledger probe alone rechecks on focus and invalidates cut-covered dependents. " +
    "Daemon-level reads retain timers because their changes need not advance the ledger cut; " +
    "cursor queries drain their pages inside queryFn instead of polling.",
  fixtures: ["packages/gui/test/query-pacing.vitest.ts", "packages/gui/test/gui-s3-r1-repo-isolation.vitest.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/gui-query-pacing.ts#guiQueryPacing.defaultValue.queryDefaults.queries.retry:fb410057d63557a4ea2884ba1d450e67",
      route: "renderer QueryClient and daemon read queries",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
