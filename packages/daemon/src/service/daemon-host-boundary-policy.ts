import type { createJsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";
import type { DaemonRepoNamespace } from "../protocol/json-rpc-server.ts";
import { canonicalRootIdentity } from "../runtime/canonical-root.ts";

export function sameCanonicalRoot(left: string, right: string): boolean {
  return canonicalRootIdentity(left) === canonicalRootIdentity(right);
}

export function sortedDaemonRepos(
  repos: ReadonlyArray<DaemonRepoNamespace>
): ReadonlyArray<DaemonRepoNamespace> {
  return [...repos].sort((left, right) =>
    left.repoId.localeCompare(right.repoId)
    || left.canonicalRoot.localeCompare(right.canonicalRoot));
}

export function localAuthorityPeerPolicy(input: Parameters<NonNullable<
  Parameters<typeof createJsonRpcProtocolServer>[0]["authorityPeerPolicy"]
>>[0]): boolean {
  if (input.actor.resolvedCredential.kind !== "unix-socket-owner-boundary") {
    return false;
  }
  const credentialUid = Number(input.actor.resolvedCredential.subject);
  const daemonUid = process.getuid?.();
  return Number.isSafeInteger(credentialUid)
    && credentialUid >= 0
    && typeof daemonUid === "number"
    && input.peerCredential.uid === credentialUid
    && input.peerCredential.uid === daemonUid;
}
