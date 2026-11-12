import { execFileSync } from "node:child_process";
import { daemonBuildStamp } from "../src/build-identity.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { oidcCenterSelections } from "../src/oidc-center-selection.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { type OidcSessionPorts } from "@harness-anything/kernel";
import { managedRbacSessionStore } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { readRuntimeExecutionPrincipal } from "../src/runtime-execution-principal-store.ts";
import { requireExecutionRequestScope } from "../src/runtime-execution-scope.ts";
import type { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";

type FleetFixture = Awaited<ReturnType<typeof fleetNodeClaimFixture>>;

/**
 * A real edge daemon host for `lease-repo` on a fleet node (node-one by default), reached through the
 * ordinary repository command RPC used by the CLI.
 */
export async function fleetEdgeHostFixture(
  t: TestContext,
  f: Pick<FleetFixture, "root" | "repo"> & {
    readonly center: Pick<FleetFixture["center"], "port">;
    readonly owners: { readonly url: string; readonly keycloak: Pick<FleetFixture["owners"]["keycloak"], "fetch"> };
  },
  options: {
    readonly name?: string;
    readonly oidcPorts?: Partial<OidcSessionPorts>;
    readonly centerPort?: number;
    readonly openCell?: Parameters<typeof openDaemonHost>[0]["openCell"];
    readonly waitForAttachments?: boolean;
    readonly runtimeLaunch?: Parameters<typeof openDaemonHost>[0]["runtimeLaunch"];
    readonly runtimeDiscover?: Parameters<typeof openDaemonHost>[0]["runtimeDiscover"];
    readonly viewRoot?: string;
    readonly personId?: string;
    readonly humanSession?: boolean;
    readonly nodeId?: string;
    readonly registerBeforeOpen?: boolean;
    readonly credential?: string;
    readonly repoId?: string;
    readonly now?: () => string;
    /** false leaves fleet-edge.json for the first `daemon.fleet.edge.sync` to write. */
    readonly writeEdgeConfig?: boolean;
    readonly beforeOpen?: (edgeRoot: string) => void | Promise<void>;
  } = {},
) {
  // The edge lives outside the center fixture's root: its daemon writes until it is closed.
  const name = options.name ?? "edge",
    root = mkdtempSync(path.join(tmpdir(), "ha-edge-host-")),
    edgeRoot = path.join(root, name),
    edgeUser = path.join(root, `${name}-user`),
    viewRoot = options.viewRoot ?? path.join(root, `${name}-view`);
  mkdirSync(path.join(edgeUser, "rbac"), { recursive: true });
  writeFileSync(
    path.join(edgeUser, "rbac", "config.json"),
    JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external" }),
  );
  mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
  writeFileSync(path.join(edgeRoot, "harness/harness.yaml"), readFileSync(path.join(f.repo, "harness/harness.yaml")));
  execFileSync("git", ["init", "-q", edgeRoot]);
  execFileSync("git", ["-C", edgeRoot, "add", "harness"]);
  execFileSync("git", [
    "-C",
    edgeRoot,
    "-c",
    "user.name=Edge Test",
    "-c",
    "user.email=edge@example.invalid",
    "commit",
    "-qm",
    "edge config",
  ]);
  execFileSync("git", ["-C", edgeRoot, "config", "user.name", "Edge Test"]);
  execFileSync("git", ["-C", edgeRoot, "config", "user.email", "edge@example.invalid"]);
  if (options.registerBeforeOpen !== false)
    registerBootstrappedDaemonRepo({
      repoId: options.repoId ?? "lease-repo",
      canonicalRoot: edgeRoot,
      userRoot: edgeUser,
      mode: "remote-edge",
      createConvenienceLinks: false,
    });
  const authority = options.oidcPorts?.loginAuthority
      ? await options.oidcPorts.loginAuthority(edgeRoot)
      : { url: f.owners.url, realm: "harness" },
    selectedAuthority = authority.url
      ? authority
      : {
          url: "https://offline-center.example",
          realm: "harness",
          clientId: `harness-node-${options.nodeId ?? "node-one"}`,
          clientSecret: options.credential ?? `secret-${options.nodeId ?? "node-one"}`,
        };
  const issuer = authority.url
      ? String(
          (
            await (
              await f.owners.keycloak.fetch(
                `${authority.url}/realms/${authority.realm}/.well-known/openid-configuration`,
              )
            ).json()
          ).issuer,
        )
      : `${selectedAuthority.url}/realms/${selectedAuthority.realm}`,
    fetch = f.owners.keycloak.fetch,
    fixtureLoginAuthority =
      options.oidcPorts?.loginAuthority ??
      (() =>
        Promise.resolve({
          url: selectedAuthority.url,
          realm: selectedAuthority.realm,
          clientId: `harness-node-${options.nodeId ?? "node-one"}`,
          clientSecret: options.credential ?? `secret-${options.nodeId ?? "node-one"}`,
        }));
  const signIn = (personId: string, sessionAuthority = selectedAuthority) =>
    managedRbacSessionStore(edgeUser, issuer, selectedAuthority.realm).write(
      JSON.stringify({
        schema: "harness-oidc-session/v3",
        issuer,
        accessToken:
          personId === (options.personId ?? "person-one")
            ? `device-token-${options.nodeId ?? "node-one"}`
            : `token-${personId}`,
        refreshToken: `refresh-${personId}`,
        subject: personId,
        personId,
        expiresAt: Date.now() + 3_600_000,
        sessionExpiresAt: Date.now() + 21_600_000,
        roles: [],
        loginTarget: edgeRoot,
        authority: sessionAuthority,
      }),
    );
  if (options.humanSession !== false) signIn(options.personId ?? "person-one");
  const config = {
    schema: "fleet-edge-config/v1",
    repoId: options.repoId ?? "lease-repo",
    host: "127.0.0.1",
    port: options.centerPort ?? f.center.port,
    servername: "localhost",
    caPath: path.join(f.root, "tls.crt"),
    nodeId: options.nodeId ?? "node-one",
    credential: options.credential ?? `secret-${options.nodeId ?? "node-one"}`,
    viewRoot,
    quotaBytes: 64 * 1024 * 1024,
    waitTimeoutMs: 2000,
  };
  if (options.writeEdgeConfig !== false) writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
  await options.beforeOpen?.(edgeRoot);
  if (authority.url)
    await createIdentitySession(edgeUser, {
      fetch,
      loginAuthority: fixtureLoginAuthority,
    }).status(edgeRoot);
  else
    oidcCenterSelections(edgeUser).write(
      edgeRoot,
      {
        issuer,
        authority: selectedAuthority,
      },
      true,
    );
  const host = await openDaemonHost({
    daemonId: `${name}-daemon`,
    ...(options.now ? { now: options.now } : {}),
    ...(options.openCell ? { openCell: options.openCell } : {}),
    ...(options.runtimeLaunch ? { runtimeLaunch: options.runtimeLaunch } : {}),
    ...(options.runtimeDiscover ? { runtimeDiscover: options.runtimeDiscover } : {}),
    userRoot: edgeUser,
    oidc: createIdentitySession(edgeUser, {
      fetch,
      ...options.oidcPorts,
      loginAuthority: fixtureLoginAuthority,
    }),
  });
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        await host.close();
      } catch (cause) {
        throw new Error(`edge host ${name} failed to close`, { cause });
      }
      rmSync(root, { recursive: true, force: true });
    })();
    return closePromise;
  };
  t.after(close);
  if (options.waitForAttachments !== false) await host.attachmentsSettled();
  const rpcServers = new Set<ReturnType<typeof createJsonRpcProtocolServer>>(),
    createRpc = () => {
      const rpc = createJsonRpcProtocolServer({
        host,
        build: daemonBuildStamp(),
        authContext: { ...auth },
        sessionPrincipal: (method, params) => host.sessionPrincipal(auth, method, params),
        executionPrincipal: async (credential, method, params) => {
          const principal = readRuntimeExecutionPrincipal(edgeRoot, credential);
          if (!principal)
            throw Object.assign(new Error("Execution credential is unknown or expired on this edge runtime."), {
              code: "authorization_denied",
            });
          requireExecutionRequestScope(principal, method, params);
          return principal;
        },
        emit: async () => undefined,
      });
      rpcServers.add(rpc);
      return rpc;
    },
    rpc = createRpc();
  t.after(() => {
    for (const server of rpcServers) server.close();
  });
  await rpc.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion, buildCommit: daemonBuildStamp().commit },
  });
  let id = 0;
  /** One CLI edge task command, as `ha task ...` sends it to the local daemon. */
  const command = async (
    action: Record<string, unknown>,
    executionCredential?: string,
  ): Promise<Record<string, unknown>> => {
    id += 1;
    const {
      schema: _schema,
      loginUrl: _loginUrl,
      loginRealm: _loginRealm,
      loginServername: _loginServername,
      loginBrowserUrl: _loginBrowserUrl,
      loginCertificate: _loginCertificate,
      ...payload
    } = config;
    const client = executionCredential ? createRpc() : rpc;
    if (executionCredential) {
      const hello = await client.handle({
        jsonrpc: "2.0",
        id: id + 10_000,
        method: "protocol.hello",
        params: {
          protocolVersion: currentDaemonProtocolVersion,
          buildCommit: daemonBuildStamp().commit,
          executionCredential,
        },
      });
      if (!hello || Array.isArray(hello) || !("result" in hello))
        throw new Error(`edge worker hello failed: ${JSON.stringify(hello)}`);
    }
    let response;
    try {
      const method = commandDescriptorForAction(String(action.kind)).method,
        { kind: _kind, ...actionPayload } = action,
        requestPayload = method === "repo.task.run" || method === "repo.task.read" ? { action } : actionPayload;
      response = await client.handle({
        jsonrpc: "2.0",
        id,
        method,
        params: { repo: { repoId: payload.repoId }, payload: requestPayload },
      });
    } finally {
      if (executionCredential) client.close();
    }
    if (!response || Array.isArray(response) || !("result" in response))
      throw new Error(`edge command failed: ${JSON.stringify(response)}`);
    return response.result as Record<string, unknown>;
  };
  const register = () =>
    host.admin(
      { kind: "register", rootDir: edgeRoot, repoId: options.repoId ?? "lease-repo", mode: "remote-edge" },
      auth,
    );
  return { host, rpc, createRpc, edgeRoot, edgeUser, viewRoot, config, command, signIn, register, issuer, close };
}
