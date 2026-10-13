import { readFileSync } from "node:fs";
import { runFleetWriteClient } from "./edge.ts";
import type { FleetEdgeChannelPayload } from "../fleet-edge-doc-sync.ts";

/** Submit explicit document candidates to the center queue. Local files are candidates only. */
export async function submitDocuments(input: {
  readonly payload: FleetEdgeChannelPayload & { readonly paths?: readonly string[]; readonly timeoutMs?: number };
  readonly readAccessToken?: () => Promise<string | undefined>;
}): Promise<Record<string, unknown>> {
  const { payload } = input;
  const peer = {
    readAccessToken: input.readAccessToken,
    hostname: payload.host,
    port: payload.port,
    ca: readFileSync(payload.caPath, "utf8"),
    servername: payload.servername,
    nodeId: payload.nodeId,
    credential: payload.credential,
    repoId: payload.repoId,
  };
  const result = await runFleetWriteClient({
    ...peer,
    timeoutMs: payload.timeoutMs ?? 60_000,
    action: { kind: "doc-submit", paths: payload.paths ?? [] },
  });
  return result as unknown as Record<string, unknown>;
}
