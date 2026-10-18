// `ha edge join <link>` on a fresh machine: sign in to the center's Keycloak, exchange the invitation for
// a machine credential, register the workspace as a remote-edge mirror and run its first sync. The
// credential reaches only fleet-edge.json (written by the edge sync); the receipt never carries it.
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileDurably } from "../durable-file.ts";
import { runProcessTextAsync } from "../process-port.ts";
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
  const authority = {
      url: link.loginUrl,
      realm: link.loginRealm,
      clientId: link.loginClientId,
      ...(link.loginCertificate ? { certificate: link.loginCertificate } : {}),
    },
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
  await prepareWorkspace(root, admitted.harnessYaml);
  // The pinned certificate is public; it becomes the trust anchor every later connection verifies against.
  writeFileDurably(caPath, new X509Certificate(Buffer.from(admitted.certificate, "base64")).toString());
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
    humanClientId: authority.clientId,
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
async function prepareWorkspace(root: string, harnessYaml: string): Promise<void> {
  const layout = path.join(root, "harness", "harness.yaml");
  if (!existsSync(layout)) writeFileDurably(layout, harnessYaml);
  // An existing checkout keeps its own repository; a fresh workspace gets one for the edge mirror.
  if (existsSync(path.join(root, ".git"))) return;
  const git = (...args: readonly string[]) => runProcessTextAsync("git", ["-C", root, ...args]);
  await git("init", "-q", "-b", "main");
  await git("add", "harness/harness.yaml");
  await git(
    "-c",
    "user.name=Harness Edge",
    "-c",
    "user.email=edge@harness.invalid",
    "commit",
    "-qm",
    "Harness edge workspace",
  );
}
