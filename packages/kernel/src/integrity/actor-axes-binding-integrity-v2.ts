import { encodeCanonicalCbor, domainHash } from "./canonical-cbor.ts";

export const actorAxesBindingCoreV2Domain = "ha/actor-axes-binding-core/v2\0";

export interface ProtocolSchemaTupleV2Core {
  readonly wire: number;
  readonly event: number;
  readonly receipt: number;
  readonly digest: number;
  readonly policy: number;
  readonly commandRegistry: number;
  readonly entityRegistry: number;
  readonly mutationRegistry: number;
  readonly localState: number;
  readonly applyJournal: number;
}

export interface ActorAxesBindingCoreV2 {
  readonly bindingId: string;
  readonly principalPersonId: string;
  readonly executorAgentId: string | null;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly schemaTuple: ProtocolSchemaTupleV2Core;
}

export function actorAxesBindingCoreDigestV2(core: ActorAxesBindingCoreV2): Uint8Array {
  return domainHash(actorAxesBindingCoreV2Domain, encodeCanonicalCbor({
    schema: "actor-axes-binding-core/v2",
    bindingId: core.bindingId,
    principalPersonId: core.principalPersonId,
    executorAgentId: core.executorAgentId,
    workspaceId: core.workspaceId,
    deviceId: core.deviceId,
    viewId: core.viewId,
    sessionId: core.sessionId,
    schemaTuple: { ...core.schemaTuple }
  }));
}
