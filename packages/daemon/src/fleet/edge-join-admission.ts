import { coded } from "../agent-runtime-contract.ts";
import type { OidcSessionService } from "../oidc-session-service.ts";
import { createEdgeJoinStore, type EdgeJoinInviteRecord } from "./edge-join.ts";

export function restoreEdgeJoinStore(journal: {
  read(): readonly string[];
  append(line: string): unknown;
}): ReturnType<typeof createEdgeJoinStore> {
  const records = journal
    .read()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (record): record is Record<string, unknown> & { readonly record: EdgeJoinInviteRecord } =>
        record.schema === "harness-edge-join/v1" &&
        record.kind === "record" &&
        typeof record.record === "object" &&
        record.record !== null,
    )
    .map((record) => record.record);
  return createEdgeJoinStore({
    records,
    onChange: (record) => journal.append(JSON.stringify({ schema: "harness-edge-join/v1", kind: "record", record })),
  });
}

export async function admitEdgeJoin(input: {
  readonly inviteToken: string;
  readonly nodeId: string;
  readonly accessToken: string;
  readonly oidc: OidcSessionService;
  readonly edgeJoins: ReturnType<typeof createEdgeJoinStore>;
  readonly registerNode: (invite: EdgeJoinInviteRecord) => Promise<string>;
}): Promise<{ readonly nodeId: string; readonly personId: string; readonly credential: string }> {
  const invite = input.edgeJoins.findByToken(input.inviteToken);
  if (!invite || invite.nodeId !== input.nodeId)
    throw coded("edge_join_invalid", "The edge join invitation is invalid.");
  if (!invite.loginClientId) throw coded("edge_join_invalid", "The invitation has no interactive login authority.");
  const auth = await input.oidc.bind({
    transportKind: "fleet-tls",
    humanAccessToken: input.accessToken,
    humanClientId: invite.loginClientId,
    nodePrincipal: { nodeId: invite.nodeId, personId: invite.personId },
  });
  if (auth.oidcPrincipal?.personId !== invite.personId)
    throw coded("person_mismatch", "The signed-in person does not match the invitation.");
  return input.oidc.serialize(async () => {
    const credential = await input.registerNode(invite);
    input.edgeJoins.consume({
      link: invite,
      loginPersonId: invite.personId,
      observedSpkiSha256: invite.spkiSha256,
      allowSamePersonRetry: true,
    });
    return { nodeId: invite.nodeId, personId: invite.personId, credential };
  });
}
