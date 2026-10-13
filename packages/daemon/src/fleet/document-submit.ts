import { readFileSync } from "node:fs";
import { runFleetWriteClient, type FleetEdgeChange } from "./edge.ts";
import type { FleetEdgeChannelPayload } from "../fleet-edge-doc-sync.ts";

/** Submit explicit document candidates to the center queue. Local files are candidates only. */
export async function submitDocuments(input: {
  readonly payload: FleetEdgeChannelPayload & {
    readonly taskId?: string;
    readonly executionId?: string | null;
    readonly baseLedgerSha?: { readonly repoId: string; readonly revision: number; readonly headDigest: string };
    readonly changes: readonly FleetEdgeChange[];
    readonly timeoutMs?: number;
  };
  readonly readAccessToken?: () => Promise<string | undefined>;
}): Promise<Record<string, unknown>> {
  const { payload } = input;
  const result = await runFleetWriteClient({
    readAccessToken: input.readAccessToken,
    hostname: payload.host,
    port: payload.port,
    ca: readFileSync(payload.caPath, "utf8"),
    servername: payload.servername,
    nodeId: payload.nodeId,
    credential: payload.credential,
    repoId: payload.repoId,
    timeoutMs: payload.timeoutMs ?? 60_000,
    channel: "collaborator",
    ...(payload.taskId ? { taskId: payload.taskId } : {}),
    ...(payload.executionId !== undefined ? { executionId: payload.executionId } : {}),
    ...(payload.baseLedgerSha ? { baseLedgerSha: payload.baseLedgerSha } : {}),
    changes: payload.changes,
  });
  return result as unknown as Record<string, unknown>;
}
