// `ha edge join <link>`: authenticate the invited person over the center's pinned TLS channel,
// then register and sync one local mirror for each repository carried by the invitation.
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileDurably } from "../durable-file.ts";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { runProcessTextAsync } from "../process-port.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { OidcLoginAuthority } from "../oidc-session-service.ts";
import { decodeEdgeJoinLink } from "./edge-join.ts";
import { probeFleetEdgeCenterAddress, requestFleetEdgeJoinPinned } from "./peer.ts";
import { fetchWithTlsCa, systemCaCertificates } from "../tls-ca-certificate.ts";

const defaultQuotaBytes = 1024 * 1024 * 1024;

/** One repository's stage inside a running join; observation only, it never steers the join. */
export interface EdgeJoinRepositoryProgress {
  readonly repoId: string;
  readonly phase: "workspace" | "register" | "sync" | "synced" | "failed";
}

/** The phases of the one join a daemon is currently running, for a read-only viewer poll. */
export interface EdgeJoinProgressSnapshot {
  readonly joinId: string;
  readonly repositories: readonly EdgeJoinRepositoryProgress[];
}

/**
 * Keeps the running join's per-repository phases in memory so a reader can paint progress while
 * `joinFleetEdge` is still awaiting register/sync. Transient: never persisted, never steers a join.
 */
export function createEdgeJoinProgressTap(): {
  readonly record: (event: { readonly joinId: string; readonly repository: EdgeJoinRepositoryProgress }) => void;
  readonly read: () => EdgeJoinProgressSnapshot | { readonly repositories: readonly [] };
} {
  let snapshot: { joinId: string; repositories: EdgeJoinRepositoryProgress[] } | undefined;
  return {
    record: ({ joinId, repository }) => {
      const current = snapshot?.joinId === joinId ? snapshot.repositories : [];
      snapshot = {
        joinId,
        repositories: [...current.filter((row) => row.repoId !== repository.repoId), repository],
      };
    },
    read: () => snapshot ?? { repositories: [] },
  };
}

export interface EdgeJoinClientPorts {
  /** The person signed in on this daemon, if any. */
  readonly session: () => Promise<
    | {
        readonly accessToken: string;
        readonly authority: {
          readonly url: string;
          readonly realm: string;
          readonly certificate?: string;
          readonly servername?: string;
        };
      }
    | undefined
  >;
  readonly beginLogin: (authority: OidcLoginAuthority) => Promise<Record<string, unknown>>;
  readonly register: (rootDir: string, repoId: string) => Promise<unknown>;
  readonly sync: (payload: JsonObject) => Promise<Record<string, unknown>>;
  readonly join?: typeof requestFleetEdgeJoinPinned;
  readonly probeCenter?: typeof probeFleetEdgeCenterAddress;
  readonly probeLogin?: (authority: OidcLoginAuthority) => Promise<void>;
  readonly homeDir?: string;
  /** Receives each repository's phase as the join loop advances, so a viewer can show progress. */
  readonly onProgress?: (progress: {
    readonly joinId: string;
    readonly repository: EdgeJoinRepositoryProgress;
  }) => void;
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
  const authority = {
    url: link.loginUrl,
    realm: link.loginRealm,
    clientId: link.loginClientId,
    ...(link.loginServername ? { servername: link.loginServername } : {}),
    ...(link.loginBrowserUrl ? { browserUrl: link.loginBrowserUrl } : {}),
    ...(link.loginCertificate ? { certificate: link.loginCertificate } : {}),
  };
  const center = new URL(link.centerOrigin),
    centerServername = link.centerServername ?? center.hostname,
    centerProbe = Promise.resolve().then(() =>
      (ports.probeCenter ?? probeFleetEdgeCenterAddress)({
        hostname: center.hostname,
        port: Number(center.port || 443),
        servername: centerServername,
        spkiSha256: link.spkiSha256,
      }),
    ),
    loginProbe = Promise.resolve().then(() => (ports.probeLogin ?? probeLoginAddress)(authority)),
    [centerResult, loginResult] = await Promise.allSettled([centerProbe, loginProbe]),
    failedAddresses = [
      ...(centerResult.status === "rejected" ? [{ address: "Center service", error: centerResult.reason }] : []),
      ...(loginResult.status === "rejected" ? [{ address: "Sign-in service", error: loginResult.reason }] : []),
    ];
  if (failedAddresses.length === 1) throw failedAddresses[0]!.error;
  if (failedAddresses.length > 1)
    throw Object.assign(
      new Error(
        failedAddresses
          .map(
            ({ address, error }) =>
              address + " address check failed: " + (error instanceof Error ? error.message : String(error)),
          )
          .join(" "),
      ),
      {
        code: "edge_join_addresses_unreachable",
        cause: new AggregateError(
          failedAddresses.map(({ error }) => error),
          "Both invitation addresses are unreachable.",
        ),
      },
    );
  const session = await ports.session();
  // An invitation CA is authoritative when present; public-trust invitations leave CA rotation unpinned.
  if (
    !session ||
    session.authority.url !== authority.url ||
    session.authority.realm !== authority.realm ||
    session.authority.servername !== authority.servername ||
    (link.loginCertificate !== undefined && session.authority.certificate !== link.loginCertificate)
  )
    return {
      ...(await ports.beginLogin(authority)),
      command: "edge-join",
      ...(link.transport ? { transport: link.transport } : {}),
    };
  const port = Number(center.port || 443),
    admitted = await (ports.join ?? requestFleetEdgeJoinPinned)({
      hostname: center.hostname,
      port,
      servername: centerServername,
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
      caPath = path.join(root, "fleet-center-ca.pem"),
      report = (phase: EdgeJoinRepositoryProgress["phase"]) =>
        ports.onProgress?.({ joinId: admitted.joinId, repository: { repoId: repository.repoId, phase } });
    report("workspace");
    await prepareWorkspace(root, repository.harnessYaml);
    // The pinned certificate is public; it becomes the trust anchor every later connection verifies against.
    writeFileDurably(caPath, certificate);
    report("register");
    await ports.register(root, repository.repoId);
    report("sync");
    const synced = await ports.sync({
      repoId: repository.repoId,
      workspaceRoot: root,
      host: center.hostname,
      port,
      servername: centerServername,
      caPath,
      nodeId: admitted.nodeId,
      credential: admitted.credential,
      humanClientId: authority.clientId,
      viewRoot: `${root}-view`,
      quotaBytes: defaultQuotaBytes,
      timeoutMs: 60_000,
    });
    if (link.transport === "ssh-reverse") {
      const existing = readFleetEdgeConfig(root);
      if (!existing) throw new Error("Fleet edge sync did not persist its connection configuration.");
      writeFleetEdgeConfig(root, {
        ...existing,
        loginUrl: authority.url,
        loginServername: authority.servername,
        loginBrowserUrl: authority.browserUrl,
        ...(authority.certificate ? { loginCertificate: authority.certificate } : {}),
      });
    }
    report(synced.ok !== false ? "synced" : "failed");
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

async function probeLoginAddress(authority: OidcLoginAuthority): Promise<void> {
  const realmUrl = new URL(`realms/${encodeURIComponent(authority.realm)}`, `${authority.url.replace(/\/$/u, "")}/`),
    address = new URL(authority.url).origin;
  try {
    const request = authority.servername
      ? fetchWithTlsCa(
          fetch,
          authority.certificate ?? systemCaCertificates(),
          realmUrl,
          { signal: AbortSignal.timeout(5_000) },
          authority.servername,
        )
      : authority.certificate
        ? fetchWithTlsCa(fetch, authority.certificate, realmUrl, { signal: AbortSignal.timeout(5_000) })
        : fetch(realmUrl, { signal: AbortSignal.timeout(5_000) });
    const response = await request;
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw Object.assign(
      new Error(
        `Login service address ${address} is unreachable or refused its realm check; check its DNS, routing, port mapping, HTTPS certificate, and realm.`,
      ),
      { code: "login_address_unreachable", cause: error },
    );
  }
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
