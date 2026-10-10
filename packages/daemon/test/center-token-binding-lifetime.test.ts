// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { binding as bindDaemonPrincipal } from "../src/daemon-host-binding.ts";
import { evaluateFleetAction } from "../src/host-action-authorization.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { fatalCellError } from "../src/repo-cell-errors.ts";
import { causeClassOf } from "../src/repo-cell-lock.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { serializableRepoCellBinding } from "../src/repo-writer-protocol.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

test("a retained user-device binding uses its current session after token rotation", async (t) => {
  let currentToken = "token-A",
    centerCalls = 0;
  const requests: { readonly route: string; readonly bearer: string | null }[] = [],
    auth: DaemonAuthenticationContext = {
      transportKind: "fleet-tls",
      nodePrincipal: { nodeId: "node-rotation", personId: "person_rotation" },
      oidcPrincipal: {
        personId: "person_rotation",
        subject: "user-rotation",
        expiresAt: Date.now() + 60_000,
        accessToken: currentToken,
        authority: { url: "https://keycloak.invalid", realm: "harness", clientId: "harness-center" },
      },
      localSessionAccessToken: async () => {
        centerCalls += 1;
        return currentToken;
      },
    },
    fetchPort: typeof fetch = async (input, init) => {
      const url = new URL(String(input)),
        route = `${url.pathname.replace("/admin/realms/harness", "")}${url.search}`,
        bearer = new Headers(init?.headers).get("authorization");
      requests.push({ route, bearer });
      if (bearer !== `Bearer ${currentToken}`) return new Response(null, { status: 401 });
      assert.equal(route, "/realms/harness/protocol/openid-connect/token");
      assert.equal(init?.method, "POST");
      assert.equal((init?.body as URLSearchParams).get("grant_type"), "urn:ietf:params:oauth:grant-type:uma-ticket");
      return Response.json({ result: true });
    },
    evaluate = (binding: RepoCellBinding) =>
      evaluateRepoCellAction({
        action: { kind: "task-create", title: "Token rotation" },
        binding,
        actionId: "op-rotation",
        repoId: "repo-rotation",
        revision: 1,
        now: "2026-10-09T00:00:00.000Z",
        fetchPort,
      }),
    retained = await bindDaemonPrincipal("/unused", auth);

  assert.equal(typeof retained.keycloakAuthorization?.session?.currentAccessToken, "function");
  assert.deepEqual(serializableRepoCellBinding(retained).keycloakAuthorization, {
    session: { ...retained.keycloakAuthorization?.session, currentAccessToken: true },
  });

  await t.test("the same action allows A before rotation and a fresh binding allows B after rotation", async () => {
    assert.equal((await evaluate(retained)).outcome, "allowed");
    currentToken = "token-B";
    const fresh = await bindDaemonPrincipal("/unused", auth);
    assert.equal((await evaluate(fresh)).outcome, "allowed");
    assert.equal(centerCalls, 2);
    assert.deepEqual(
      requests.map(({ bearer }) => bearer),
      ["Bearer token-A", "Bearer token-B"],
    );
  });

  await t.test("the retained binding must also authorize with B", async () => {
    requests.length = 0;
    await assert.doesNotReject(async () => {
      try {
        assert.equal((await evaluate(retained)).outcome, "allowed");
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            action: "task-create",
            centerBinding: typeof retained.keycloakAuthorization?.center,
            current: currentToken,
            centerCalls,
            requests,
            fatal: fatalCellError(error),
            causeClass: causeClassOf(error),
          }),
        );
        throw error;
      }
    }, "a long-lived binding must consult its current user session at authorization time");
  });

  await t.test("center authority cannot replace a missing or mismatched user session", async () => {
    let borrowed = 0;
    const center = async () => {
      borrowed += 1;
      throw new Error("must not borrow center authority");
    };
    assert.equal((await evaluate({ ...retained, keycloakAuthorization: { center } })).outcome, "denied");
    assert.equal(
      (
        await evaluate({
          ...retained,
          keycloakAuthorization: {
            center,
            session: { ...retained.keycloakAuthorization!.session!, personId: "another-person" },
          },
        })
      ).outcome,
      "denied",
    );
    assert.equal(
      (
        await evaluateFleetAction({
          kind: "daemon-repo-register",
          binding: { ...retained, keycloakAuthorization: { center } },
          actionId: "host-no-session",
          evaluatedAtCut: "test",
          fetchPort,
        })
      ).outcome,
      "denied",
    );
    assert.equal(borrowed, 0);
  });

  await t.test("an Admin 401 is coded, non-fatal, and not a data-shape failure", async () => {
    let rejection: unknown;
    try {
      await new KeycloakPolicyAdapter(
        { url: "https://keycloak.invalid", realm: "harness", resourceServerClientId: "harness-center" },
        async () => new Response(null, { status: 401 }),
      ).findUserId("infrastructure-token", "person_rotation");
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection instanceof Error);
    assert.equal((rejection as Error & { readonly code?: string }).code, "keycloak_admin_rejected");
    assert.equal(fatalCellError(rejection), false);
    assert.equal(causeClassOf(rejection), "infrastructure");
  });
});

test("a verified local socket owner authorizes local work without borrowing Keycloak", async () => {
  const ownerUid = process.getuid?.() ?? 0,
    local = await bindDaemonPrincipal("/unused", {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid, source: "unix-socket-filesystem-owner-boundary" },
    }),
    repoDecision = await evaluateRepoCellAction({
      action: { kind: "task-create", taskId: "task-local", title: "Local" },
      binding: local,
      actionId: "local-task-create",
      repoId: "repo-local",
      revision: 1,
      now: "2026-10-11T00:00:00.000Z",
    }),
    hostDecision = await evaluateFleetAction({
      kind: "daemon-control-request",
      binding: local,
      actionId: "local-control",
      evaluatedAtCut: "daemon-control:current",
    });

  assert.equal(local.actor.principal.personId, `local-user-${ownerUid}`);
  assert.equal(local.daemonSocketOwner, true);
  assert.equal(local.keycloakAuthorization, undefined);
  assert.equal(repoDecision.outcome, "allowed");
  assert.deepEqual(repoDecision.bindingsUsed, [{ proof: "unix-socket-owner-boundary", scope: "task-create" }]);
  assert.equal(hostDecision.outcome, "allowed");
  assert.equal(hostDecision.policyRef, "daemon-socket-owner@1");
  await assert.rejects(
    bindDaemonPrincipal("/unused", {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid: ownerUid + 1, source: "unix-socket-filesystem-owner-boundary" },
    }),
    { code: "authentication_required" },
  );
  await assert.rejects(
    bindDaemonPrincipal("/unused", {
      transportKind: "fleet-tls",
      nodePrincipal: { nodeId: "node-no-session", personId: "person-owner" },
      keycloakCenter: async () => {
        throw new Error("fleet transport must not borrow center authorization");
      },
    }),
    { code: "authentication_required" },
  );
});
