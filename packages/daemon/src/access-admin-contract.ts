import type { managedRbacReceiptJournal } from "./access-admin-state.ts";
import type { createEdgeJoinStore } from "./fleet/edge-join.ts";
import type { EdgeJoinSshTunnelManager } from "./fleet/edge-join-ssh-tunnel.ts";

import type { accessAdminOperations } from "./protocol/daemon-protocol.contract.ts";
import type { AccessAdminRequest } from "@harness-anything/kernel";

export type AccessAdminOperation = (typeof accessAdminOperations)[number];

export interface AccessAdminPorts {
  readonly fetch: typeof fetch;
  readonly now: () => string;
  readonly journal: ReturnType<typeof managedRbacReceiptJournal>;
  readonly daemonId?: string;
  readonly nodeRetirement?: import("./fleet/node-retirement.ts").NodeRetirement;
  readonly onNodeRemoved?: (nodeId: string) => void;
  readonly sshTunnels?: EdgeJoinSshTunnelManager;
  readonly edgeJoins?: ReturnType<typeof createEdgeJoinStore>;
}

export type { AccessAdminRequest };
