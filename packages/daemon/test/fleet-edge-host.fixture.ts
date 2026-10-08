import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import type { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";

type FleetFixture = Awaited<ReturnType<typeof fleetNodeClaimFixture>>;

/**
 * A real edge daemon host for `lease-repo` on a fleet node (node-one by default), reached through the same local JSON-RPC
 * method the CLI uses for edge task commands (`daemon.fleet.task.run`).
 */
export async function fleetEdgeHostFixture(
  t: TestContext,
  f: Pick<FleetFixture, "root" | "repo"> & {
    readonly center: Pick<FleetFixture["center"], "port">;
    readonly owners: { readonly keycloak: Pick<FleetFixture["owners"]["keycloak"], "fetch"> };
  },
  options: {
    readonly name?: string;
    readonly centerPort?: number;
    readonly openCell?: Parameters<typeof openDaemonHost>[0]["openCell"];
    readonly waitForAttachments?: boolean;
    readonly runtimeLaunch?: Parameters<typeof openDaemonHost>[0]["runtimeLaunch"];
    readonly runtimeDiscover?: Parameters<typeof openDaemonHost>[0]["runtimeDiscover"];
    readonly viewRoot?: string;
    readonly personId?: string;
    readonly nodeId?: string;
  } = {},
) {
  // The edge lives outside the center fixture's root: its daemon writes until it is closed.
  const name = options.name ?? "edge",
    root = mkdtempSync(path.join(tmpdir(), "ha-edge-host-")),
    edgeRoot = path.join(root, name),
    edgeUser = path.join(root, `${name}-user`),
    viewRoot = options.viewRoot ?? path.join(root, `${name}-view`);
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
  registerBootstrappedDaemonRepo({
    repoId: "lease-repo",
    canonicalRoot: edgeRoot,
    userRoot: edgeUser,
    mode: "remote-edge",
    createConvenienceLinks: false,
  });
  const signIn = (personId: string) =>
    managedRbacSessionStore(edgeUser).write(
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: `token-${personId}`,
        subject: personId,
        personId,
        expiresAt: Date.now() + 3_600_000,
        roles: [],
        loginTarget: edgeRoot,
        authority: { url: "https://keycloak.example", realm: "harness" },
      }),
    );
  signIn(options.personId ?? "person-one");
  const config = {
    schema: "fleet-edge-config/v1",
    repoId: "lease-repo",
    host: "127.0.0.1",
    port: options.centerPort ?? f.center.port,
    servername: "localhost",
    caPath: path.join(f.root, "tls.crt"),
    nodeId: options.nodeId ?? "node-one",
    credential: `secret-${options.nodeId ?? "node-one"}`,
    viewRoot,
    quotaBytes: 64 * 1024 * 1024,
    waitTimeoutMs: 2000,
  };
  writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
  const host = await openDaemonHost({
    daemonId: `${name}-daemon`,
    ...(options.openCell ? { openCell: options.openCell } : {}),
    ...(options.runtimeLaunch ? { runtimeLaunch: options.runtimeLaunch } : {}),
    ...(options.runtimeDiscover ? { runtimeDiscover: options.runtimeDiscover } : {}),
    userRoot: edgeUser,
    oidc: new OidcSessionService(edgeUser, { fetch: f.owners.keycloak.fetch }),
  });
  t.after(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (options.waitForAttachments !== false) await host.attachmentsSettled();
  const rpc = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  t.after(() => rpc.close());
  await rpc.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  let id = 0;
  /** One CLI edge task command, as `ha task ...` sends it to the local daemon. */
  const command = async (action: Record<string, unknown>): Promise<Record<string, unknown>> => {
    id += 1;
    const { schema: _schema, ...payload } = config;
    const response = await rpc.handle({
      jsonrpc: "2.0",
      id,
      method: "daemon.fleet.task.run",
      params: { payload: { ...payload, action } },
    });
    if (!response || Array.isArray(response) || !("result" in response))
      throw new Error(`edge command failed: ${JSON.stringify(response)}`);
    return response.result as Record<string, unknown>;
  };
  return { host, rpc, edgeRoot, edgeUser, viewRoot, config, command, signIn };
}
