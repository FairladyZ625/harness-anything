// `ha edge join <link>`: authenticate the invited person over the center's pinned TLS channel,
// then register and sync one local mirror for each repository carried by the invitation.
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
  if (!link.token)
    throw Object.assign(new Error("The invitation has no token; ask for a new invitation."), {
      code: "edge_join_invalid",
    });
  const authority = { url: link.loginUrl, realm: link.loginRealm, clientId: link.loginClientId },
    session = await ports.session();
  // A session for another Keycloak would be rejected by the center; sign in to the invitation's.
  if (!session || session.authority.url !== authority.url || session.authority.realm !== authority.realm)
    return { ...(await ports.beginLogin(authority)), command: "edge-join" };
  const center = new URL(link.centerOrigin),
    port = Number(center.port || 443),
    admitted = await (ports.join ?? requestFleetEdgeJoinPinned)({
      hostname: center.hostname,
      port,
      servername: center.hostname,
      joinId: link.joinId,
      inviteToken: link.token,
      accessToken: session.accessToken,
      spkiSha256: link.spkiSha256,
    }),
    certificate = new X509Certificate(Buffer.from(admitted.certificate, "base64")).toString(),
    repositories = [] as {
      readonly repoId: string;
      readonly workspaceRoot: string;
      readonly mirrorOutcome?: unknown;
      readonly knownHead?: unknown;
      readonly ok: boolean;
      readonly code?: unknown;
      readonly error?: unknown;
    }[];

  for (const repository of admitted.repositories) {
    const root = edgeWorkspaceRoot(repository.repoId, request.workspaceRoot, ports.homeDir ?? homedir()),
      caPath = path.join(root, "fleet-center-ca.pem");
    await prepareWorkspace(root, repository.harnessYaml);
    // The pinned certificate is public; it becomes the trust anchor every later connection verifies against.
    writeFileDurably(caPath, certificate);
    await ports.register(root, repository.repoId);
    const synced = await ports.sync({
      repoId: repository.repoId,
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
    repositories.push({
      repoId: repository.repoId,
      workspaceRoot: root,
      ok: synced.ok !== false,
      ...(synced.mirrorOutcome === undefined ? {} : { mirrorOutcome: synced.mirrorOutcome }),
      ...(synced.knownHead === undefined ? {} : { knownHead: synced.knownHead }),
      ...(synced.ok === false ? { code: synced.code, error: synced.error } : {}),
    });
  }
  return {
    ok: repositories.every((repository) => repository.ok),
    command: "edge-join",
    joinId: admitted.joinId,
    state: repositories.every((repository) => repository.ok) ? "synced" : "partial",
    repoIds: repositories.map((repository) => repository.repoId),
    repositories,
    nodeId: admitted.nodeId,
    personId: admitted.personId,
  };
}

function edgeWorkspaceRoot(repoId: string, requestedRoot: string | undefined, homeDir: string): string {
  if (!requestedRoot) return path.join(homeDir, "harness-edge", repoId);
  const base = path.resolve(requestedRoot);
  return path.join(base, repoId);
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
