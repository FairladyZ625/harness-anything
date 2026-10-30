import type { managedRbacReceiptJournal } from "./managed-rbac-service.ts";
import type { createEdgeJoinStore } from "./fleet/edge-join.ts";
import type { EdgeJoinSshTunnelManager } from "./fleet/edge-join-ssh-tunnel.ts";

import type { accessAdminOperations } from "./protocol/daemon-protocol.contract.ts";

export type AccessAdminOperation = (typeof accessAdminOperations)[number];

export interface AccessAdminRequest {
  readonly operation?: string;
  readonly rootDir?: string;
  readonly operationId?: string;
  readonly groupId?: string;
  readonly displayName?: string;
  readonly scopes?: readonly unknown[];
  readonly composites?: readonly unknown[];
  readonly expectedVersion?: string;
  readonly personId?: string;
  readonly username?: string;
  readonly email?: string;
  readonly repoIds?: readonly unknown[];
  readonly groupIds?: readonly unknown[];
  readonly nodeLabel?: string;
  readonly resource?: string;
  readonly sessionLifetimeSeconds?: number;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly nodeId?: string;
  readonly systemName?: string;
  readonly platform?: string;
  readonly transport?: "direct" | "ssh-reverse";
  readonly sshTarget?: string;
  readonly credentialFile?: string;
  readonly joinId?: string;
  readonly requestId?: string;
  readonly requestVersion?: number;
  readonly decision?: "approve" | "reject";
  readonly rationale?: string;
}

export interface AccessAdminPorts {
  readonly fetch: typeof fetch;
  readonly now: () => string;
  readonly journal: ReturnType<typeof managedRbacReceiptJournal>;
  readonly daemonId?: string;
  readonly onNodeRemoved?: (nodeId: string) => void;
  readonly sshTunnels?: EdgeJoinSshTunnelManager;
  readonly edgeJoins?: ReturnType<typeof createEdgeJoinStore>;
}
