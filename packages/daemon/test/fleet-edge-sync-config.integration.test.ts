// harness-test-tier: integration
// `ha daemon fleet edge sync` on a fresh edge: the admitted connection becomes the workspace's
// fleet-edge.json and the resident replica stream starts on it; a sync with a changed connection
// rewrites the file and restarts the stream on the new settings.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";

test(
  "a successful edge sync persists its connection and starts the resident stream",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "synced-0", title: "Synced 0" })).outcome,
      "applied",
    );
    const e = await fleetEdgeHostFixture(t, f, { writeEdgeConfig: false });
    const configFile = path.join(e.edgeRoot, "fleet-edge.json");
    assert.equal(existsSync(configFile), false);
    const { schema: _schema, waitTimeoutMs: _wait, ...connection } = e.config;
    let id = 100;
    const edgeSync = async (payload: Record<string, unknown>) => {
      id += 1;
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id,
        method: "daemon.fleet.edge.sync",
        params: { payload: { ...payload, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
      });
      if (!response || Array.isArray(response) || !("result" in response))
        throw new Error(`edge sync failed: ${JSON.stringify(response)}`);
      return response.result as Record<string, unknown>;
    };

    const first = await edgeSync(connection);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.outcome, "applied");
    assert.deepEqual(readFleetEdgeConfig(e.edgeRoot), connection);
    assert.equal(statSync(configFile).mode & 0o777, 0o600, "the file carries the machine credential");

    writeFleetEdgeConfig(e.edgeRoot, {
      ...connection,
      loginUrl: f.owners.url,
      loginBrowserUrl: f.owners.url,
      humanClientId: "harness-gui",
    });
    f.owners.keycloak.interactiveSession(
      "person-one",
      "node-one",
      f.owners.url,
      "device-token-node-one",
      "harness-gui",
    );

    // A changed connection is rewritten and the stream restarts on it; sync waits on the new stream.
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "synced-1", title: "Synced 1" })).outcome,
      "applied",
    );
    const changed = { ...connection, quotaBytes: connection.quotaBytes * 2 };
    const second = await edgeSync(changed);
    assert.equal(second.ok, true, JSON.stringify(second));
    const persisted = readFleetEdgeConfig(e.edgeRoot)!;
    const {
      loginUrl: _loginUrl,
      loginServername: _loginServername,
      loginBrowserUrl: _loginBrowserUrl,
      loginCertificate: _loginCertificate,
      humanClientId: _humanClientId,
      ...persistedConnection
    } = persisted;
    assert.deepEqual(persistedConnection, changed);
    assert.equal(persisted?.loginUrl, f.owners.url);
    assert.equal(persisted?.loginBrowserUrl, f.owners.url);
    assert.equal(persisted?.humanClientId, "harness-gui");
    const listed = await e.command({ kind: "task-list" });
    const rows = listed.rows as Array<{ readonly taskId?: string }>;
    assert.deepEqual(
      rows
        .map((row) => row.taskId)
        .filter((taskId) => taskId?.startsWith("synced-"))
        .sort(),
      ["synced-0", "synced-1"],
    );
  },
);

test(
  "a manual edge sync presents the invitation's interactive client, not the node client",
  { timeout: 180_000 },
  async (t) => {
    // #4019's field report: the edge is signed in through the invitation's interactive client
    // (`harness-gui` on the CEO's Ubuntu node) while the center audits `azp`. A manual sync that
    // omits humanClientId made the center assert the node client instead, so every retry failed with
    // human_confirmation_required while the session was live. The invitation's client is already
    // persisted by join; a manual sync must relay that value instead of letting the center guess.
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const e = await fleetEdgeHostFixture(t, f);
    // Keycloak minted this device session under the invitation's interactive client, as a real join does.
    f.owners.keycloak.interactiveSession(
      "person-one",
      "node-one",
      f.owners.url,
      "device-token-node-one",
      "harness-gui",
    );
    // The RPC payload is the closed connection shape; the freshness tuning in fleet-edge.json is not one.
    const observedAzp: unknown[] = [],
      keycloakFetch = f.owners.keycloak.fetch;
    f.owners.keycloak.fetch = (async (input, init) => {
      const response = await keycloakFetch(input, init);
      if (String(input).endsWith("/protocol/openid-connect/token/introspect")) {
        const claims = (await response.clone().json()) as { readonly azp?: unknown };
        observedAzp.push(claims.azp);
      }
      return response;
    }) as typeof fetch;
    const { waitTimeoutMs: _wait, ...connection } = readFleetEdgeConfig(e.edgeRoot)!,
      sync = async () => {
        const response = await e.rpc.handle({
          jsonrpc: "2.0",
          id: 200,
          method: "daemon.fleet.edge.sync",
          params: { payload: { ...connection, workspaceRoot: e.edgeRoot, timeoutMs: 30_000 } },
        });
        assert.ok(response && !Array.isArray(response), JSON.stringify(response));
        return "result" in response ? (response.result as Record<string, unknown>) : {};
      };
    // The live token's actual azp is safe diagnostic data. With humanClientId absent, center verification
    // defaults to the node client and rejects this same otherwise-valid request.
    const missingClient = await sync(),
      fallbackAzp = `harness-node-${connection.nodeId}`;
    assert.equal(observedAzp[0], "harness-gui");
    assert.notEqual(observedAzp[0], fallbackAzp);
    assert.equal(missingClient.code, "human_confirmation_required");
    t.diagnostic(
      JSON.stringify({
        field: "azp",
        observedAzp: observedAzp[0],
        expectedAzpWithoutHumanClientId: fallbackAzp,
        result: missingClient.code,
        tokenLogged: false,
      }),
    );
    // Join persists the interactive client beside the machine credential; the manual sync reads it.
    writeFleetEdgeConfig(e.edgeRoot, { ...connection, humanClientId: "harness-gui" });
    const synced = await sync();
    assert.equal(observedAzp[1], "harness-gui");
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    assert.equal(readFleetEdgeConfig(e.edgeRoot)?.humanClientId, "harness-gui", "the sync keeps the invitation client");
    t.diagnostic(
      JSON.stringify({
        field: "azp",
        observedAzp: observedAzp[1],
        expectedAzpWithHumanClientId: "harness-gui",
        result: synced.outcome,
        tokenLogged: false,
      }),
    );
  },
);
