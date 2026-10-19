import { randomUUID } from "node:crypto";
import { coded } from "../agent-runtime-contract.ts";
import type { OidcSessionService } from "../oidc-session-service.ts";
import { createEdgeJoinStore, type EdgeJoinRecord } from "./edge-join.ts";

export function restoreEdgeJoinStore(journal: {
  read(): readonly string[];
  append(line: string): unknown;
}): ReturnType<typeof createEdgeJoinStore> {
  const records = journal
    .read()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (record): record is Record<string, unknown> & { readonly record: EdgeJoinRecord } =>
        record.schema === "harness-edge-join/v2" &&
        record.kind === "record" &&
        typeof record.record === "object" &&
        record.record !== null,
    )
    .map((record) => record.record);
  return createEdgeJoinStore({
    records,
    onChange: (record) => journal.append(JSON.stringify({ schema: "harness-edge-join/v2", kind: "record", record })),
  });
}

export async function admitEdgeJoin(input: {
  readonly joinId: string;
  readonly inviteToken: string;
  readonly accessToken: string;
  readonly oidc: OidcSessionService;
  readonly edgeJoins: ReturnType<typeof createEdgeJoinStore>;
  readonly validateSnapshot: (record: EdgeJoinRecord) => Promise<void>;
  readonly registerNode: (record: EdgeJoinRecord, nodeId: string) => Promise<string>;
}): Promise<{
  readonly joinId: string;
  readonly nodeId: string;
  readonly personId: string;
  readonly credential: string;
  readonly repoIds: readonly string[];
}> {
  const initial = input.edgeJoins.assertConsumable(input.joinId, input.inviteToken),
    nodeId = randomUUID(),
    auth = await input.oidc.bind({
      transportKind: "fleet-tls",
      humanAccessToken: input.accessToken,
      humanClientId: initial.loginClientId,
      nodePrincipal: { nodeId, personId: initial.personId },
    });
  if (auth.oidcPrincipal?.personId !== initial.personId)
    throw coded("person_mismatch", "The signed-in person does not match the invitation.");
  return input.oidc.serialize(async () => {
    // Revocation and competing consumption share the OIDC writer with this final check and transition.
    const record = input.edgeJoins.assertConsumable(input.joinId, input.inviteToken);
    if (record.personId !== initial.personId)
      throw coded("edge_join_invalid", "The edge join invitation changed during admission.");
    await input.validateSnapshot(record);
    const credential = await input.registerNode(record, nodeId);
    input.edgeJoins.consume(input.joinId, input.inviteToken, nodeId);
    return { joinId: record.joinId, nodeId, personId: record.personId, credential, repoIds: record.repoIds };
  });
}
