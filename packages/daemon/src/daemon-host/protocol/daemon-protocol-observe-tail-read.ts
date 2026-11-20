import type { EntityResidencyFacets } from "@harness-anything/kernel";
import { repoReadCommandTopology } from "@harness-anything/preset/internal/preset-command-contract";
import { observeTailKinds, shape } from "./daemon-protocol-results.ts";

/** The observe.tail read facet(自 daemon-protocol-read-routes.ts 按职责拆出:该目录
 * 文件在复杂度 ratchet 上只许缩不许涨,observe 流读是一个内聚的自足块)。 */
export const observeTailReadMethod = Object.freeze({
  id: "observe.tail",
  phase: "G8",
  method: "observe.tail",
  requiresRepo: true,
  params: shape({
    repo: shape({ repoId: "string" }),
    payload: shape({
      kind: { values: observeTailKinds, optional: false },
      direction: { values: ["history", "follow"], optional: false },
      cursor: "json?",
      dispatchId: "string?",
      scopePersonId: "string?",
      filterNodeId: "string?",
    }),
  }),
  ...repoReadCommandTopology,
  residency: Object.freeze({
    events: "projection",
    "repo-log": "runtime-local",
    "daemon-log": "runtime-local",
    lifecycle: "runtime-local",
    dispatch: "runtime-local",
  } satisfies EntityResidencyFacets),
} as const);
