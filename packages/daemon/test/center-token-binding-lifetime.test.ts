// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { binding as bindDaemonPrincipal } from "../src/daemon-host-binding.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import { fatalCellError } from "../src/repo-cell-errors.ts";
import { causeClassOf } from "../src/repo-cell-lock.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { serializableRepoCellBinding } from "../src/repo-writer-protocol.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

// dec_2665E58BA5AE42E37793193748/CH1: evaluation uses the service account, never an owner lookup.
test("a retained machine binding uses current center authority after token rotation", async (t) => {
  let currentToken = "token-A",
    centerCalls = 0;
  const requests: { readonly route: string; readonly bearer: string | null }[] = [],
    auth: DaemonAuthenticationContext = {
      transportKind: "fleet-tls",
      nodePrincipal: { nodeId: "node-rotation", personId: "person_rotation", subject: "user-rotation" },
      keycloakCenter: async () => {
        centerCalls += 1;
        return {
          url: "https://keycloak.invalid",
          realm: "harness",
          clientId: "harness-center",
          accessToken: currentToken,
        };
      },
    },
    fetchPort: typeof fetch = async (input, init) => {
      const url = new URL(String(input)),
        route = `${url.pathname.replace("/admin/realms/harness", "")}${url.search}`,
        bearer = new Headers(init?.headers).get("authorization");
      requests.push({ route, bearer });
      if (bearer !== `Bearer ${currentToken}`) return new Response(null, { status: 401 });
      switch (route) {
        case "/users?q=harness_person_id%3Aperson_rotation&exact=true":
          return Response.json([{ id: "user-rotation" }]);
        case "/clients?clientId=harness-center":
          return Response.json([{ id: "center-client" }]);
        case "/clients/center-client/authz/resource-server/resource?name=repo-rotation&exactName=true":
          return Response.json([{ _id: "repo-resource", name: "repo-rotation" }]);
        case "/clients/center-client/authz/resource-server/policy/evaluate":
          assert.equal(init?.method, "POST");
          assert.equal(JSON.parse(String(init.body)).userId, "user-rotation");
          return Response.json({ status: "PERMIT", results: [{ status: "PERMIT" }] });
        default:
          throw new Error(`Unexpected fixture request: ${route}`);
      }
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

  assert.equal(typeof retained.keycloakAuthorization?.center, "function");
  assert.deepEqual(serializableRepoCellBinding(retained).keycloakAuthorization, { center: true });

  await t.test("the same action allows A before rotation and a fresh binding allows B after rotation", async () => {
    assert.equal((await evaluate(retained)).outcome, "allowed");
    currentToken = "token-B";
    const fresh = await bindDaemonPrincipal("/unused", auth);
    assert.equal((await evaluate(fresh)).outcome, "allowed");
    assert.equal(centerCalls, 2);
    assert.deepEqual(
      requests.map(({ bearer }) => bearer),
      [...Array<string>(3).fill("Bearer token-A"), ...Array<string>(3).fill("Bearer token-B")],
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
    }, "a long-lived binding must consult current center authority at authorization time");
  });

  await t.test("an Admin 401 is coded, non-fatal, and not a data-shape failure", async () => {
    let rejection: unknown;
    try {
      await evaluateRepoCellAction({
        action: { kind: "task-create", title: "Rejected authorization" },
        binding: retained,
        actionId: "op-rejected",
        repoId: "repo-rotation",
        revision: 2,
        now: "2026-10-09T00:00:01.000Z",
        fetchPort: async () => new Response(null, { status: 401 }),
      });
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection instanceof Error);
    assert.equal((rejection as Error & { readonly code?: string }).code, "keycloak_admin_rejected");
    assert.equal(fatalCellError(rejection), false);
    assert.equal(causeClassOf(rejection), "infrastructure");
  });
});
