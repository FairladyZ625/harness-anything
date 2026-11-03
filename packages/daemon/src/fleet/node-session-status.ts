import { existsSync, readFileSync } from "node:fs";
import { writeCenterDurableJson } from "./center-transport.ts";

export interface FleetNodeSessionFact {
  readonly nodeId: string;
  readonly buildCommit: string | null;
  /** Last time the transport observed a replication connection, never an ACK timestamp. */
  readonly lastOnlineAt: string | null;
  readonly lastFailure: { readonly code: string; readonly at: string; readonly message: string } | null;
}

export interface FleetNodeSessionStatus extends FleetNodeSessionFact {
  readonly connected: boolean;
}

/** Center transport telemetry, independent of canonical events and replication ACKs.
 * One overwritten row per authenticated node; O(nodes) space and snapshot/write cost.
 * Live sockets are deliberately never persisted: reopening a center starts offline. */
export function createNodeSessionStatus(input: { readonly file: string; readonly now: () => string }) {
  const rows = new Map<string, FleetNodeSessionFact>(
      (existsSync(input.file) ? (JSON.parse(readFileSync(input.file, "utf8")) as FleetNodeSessionFact[]) : []).map(
        (row) => [row.nodeId, row],
      ),
    ),
    empty = (nodeId: string): FleetNodeSessionFact => ({
      nodeId,
      buildCommit: null,
      lastOnlineAt: null,
      lastFailure: null,
    }),
    write = (nodeId: string, patch: Partial<FleetNodeSessionFact>): void => {
      rows.set(nodeId, { ...(rows.get(nodeId) ?? empty(nodeId)), ...patch });
      writeCenterDurableJson(input.file, [...rows.values()]);
    };
  return {
    hello: (nodeId: string, buildCommit: string | null): void =>
      write(nodeId, buildCommit === null ? {} : { buildCommit }),
    online(nodeId: string): void {
      if (rows.has(nodeId)) write(nodeId, { lastOnlineAt: input.now() });
    },
    failure(nodeId: string, code: string, message: string): void {
      if (rows.has(nodeId)) write(nodeId, { lastFailure: { code, at: input.now(), message: message.slice(0, 4096) } });
    },
    removeNode(nodeId: string): void {
      rows.delete(nodeId);
      writeCenterDurableJson(input.file, [...rows.values()]);
    },
    snapshot(knownNodes: readonly string[], connectedNodes: ReadonlySet<string>): readonly FleetNodeSessionStatus[] {
      return [...new Set([...rows.keys(), ...knownNodes])].map((nodeId) => ({
        ...(rows.get(nodeId) ?? empty(nodeId)),
        connected: connectedNodes.has(nodeId),
      }));
    },
  };
}
