// `ha edge join <link>` on a fresh machine: sign in to the center's Keycloak, exchange the invitation for
// a machine credential, register the workspace as a remote-edge mirror and run its first sync. The
// credential reaches only fleet-edge.json (written by the edge sync); the receipt never carries it.
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { OidcLoginAuthority } from "../oidc-session-service.ts";
import { decodeEdgeJoinLink } from "./edge-join.ts";
import { requestFleetEdgeJoinPinned } from "./peer.ts";

const defaultQuotaBytes = 1024 * 1024 * 1024;

export interface EdgeJoinClientPorts {
  /** The person signed in on this daemon, if any. */
  readonly session: () => Promise<
    { readonly accessToken: string; readonly authority: { readonly url: string; readonly realm: string } } | undefined
  >;
  readonly beginLogin: (authority: OidcLoginAuthority) => Promise<Record<string, unknown>>;
  readonly register: (rootDir: string, repoId: string) => Promise<unknown>;
  readonly sync: (payload: JsonObject) => Promise<Record<string, unknown>>;
  readonly join?: typeof requestFleetEdgeJoinPinned;
  readonly homeDir?: string;
}

export async function joinFleetEdge(
  request: { readonly link: string; readonly workspaceRoot?: string },
  ports: EdgeJoinClientPorts,
): Promise<Record<string, unknown>> {
  const link = decodeEdgeJoinLink(request.link);
  if (!link.loginUrl || !link.loginRealm || !link.loginClientId)
    throw Object.assign(new Error("The invitation carries no center sign-in; ask for a new invitation."), {
      code: "edge_join_invalid",
    });
  const authority = { url: link.loginUrl, realm: link.loginRealm, clientId: link.loginClientId },
    session = await ports.session();
  // A session for another Keycloak would be rejected by the center; sign in to the invitation's.
  if (!session || session.authority.url !== authority.url || session.authority.realm !== authority.realm)
    return { ...(await ports.beginLogin(authority)), command: "edge-join" };
  const center = new URL(link.centerUrl),
    port = Number(center.port || 443),
    admitted = await (ports.join ?? requestFleetEdgeJoinPinned)({
      hostname: center.hostname,
      port,
      servername: center.hostname,
      nodeId: link.nodeId,
      inviteToken: link.token,
      accessToken: session.accessToken,
      spkiSha256: link.spkiSha256,
    }),
    root = path.resolve(
      request.workspaceRoot ?? path.join(ports.homeDir ?? homedir(), "harness-edge", admitted.repoId),
    ),
    caPath = path.join(root, "fleet-center-ca.pem");
  prepareWorkspace(root, admitted.harnessYaml);
  // The pinned certificate is public; it becomes the trust anchor every later connection verifies against.
  writeFileSync(caPath, new X509Certificate(Buffer.from(admitted.certificate, "base64")).toString());
  await ports.register(root, admitted.repoId);
  const synced = await ports.sync({
    repoId: admitted.repoId,
    workspaceRoot: root,
    host: center.hostname,
    port,
    servername: center.hostname,
    caPath,
    nodeId: admitted.nodeId,
    credential: admitted.credential,
    viewRoot: `${root}-view`,
    quotaBytes: defaultQuotaBytes,
    timeoutMs: 60_000,
  });
  return {
    ok: synced.ok !== false,
    command: "edge-join",
    repoId: admitted.repoId,
    nodeId: admitted.nodeId,
    personId: admitted.personId,
    workspaceRoot: root,
    mirrorOutcome: synced.mirrorOutcome,
    knownHead: synced.knownHead,
    ...(synced.ok === false ? { code: synced.code, error: synced.error } : {}),
  };
}

/** A remote-edge registration needs the center's layout file inside a Git repository with a branch. */
function prepareWorkspace(root: string, harnessYaml: string): void {
  const layout = path.join(root, "harness", "harness.yaml");
  if (!existsSync(layout)) {
    mkdirSync(path.dirname(layout), { recursive: true });
    writeFileSync(layout, harnessYaml);
  }
  const git = (args: readonly string[]) => execFileSync("git", args, { stdio: "ignore", windowsHide: true });
  try {
    git(["-C", root, "rev-parse", "--show-toplevel"]);
    return;
  } catch (error) {
    // Not a Git checkout yet: the edge mirror gets its own repository.
    consumeKnownError(error);
  }
  git(["init", "-q", "-b", "main", root]);
  git(["-C", root, "add", "harness/harness.yaml"]);
  git([
    "-C",
    root,
    "-c",
    "user.name=Harness Edge",
    "-c",
    "user.email=edge@harness.invalid",
    "commit",
    "-qm",
    "Harness edge workspace",
  ]);
}
