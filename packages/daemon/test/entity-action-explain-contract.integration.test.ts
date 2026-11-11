// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";

const method = "repo.entity.actions.explain" as const,
  requestSchema = "entity-action-explain-request/v1" as const,
  fixedNow = "2026-11-06T03:00:00.000Z";

function explainPayload(refs: readonly string[]) {
  return { schema: requestSchema, mode: "object" as const, entityKind: null, refs };
}

function catalogPayload(entityKind: string) {
  return { schema: requestSchema, mode: "catalog" as const, entityKind, refs: [] };
}

async function openExplainFixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-explain-contract-")),
    repoId = workspaceId("explain-contract"),
    realm = await serveKeycloak(),
    provider = new KeycloakPolicyAdapter(
      { url: realm.url, realm: "harness", resourceServerClientId: "harness-center" },
      realm.fetch,
    ),
    personId = actor.principal.personId,
    binding: RepoCellBinding = {
      actor,
      source: "local",
      keycloakAuthorization: {
        session: {
          provider,
          personId,
          accessToken: realm.keycloak.account(personId),
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
        },
      },
    };
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "explain-contract",
    now: () => fixedNow,
  });
  return { rootDir, repoId, realm, provider, binding, cell };
}

async function createTask(
  fixture: Awaited<ReturnType<typeof openExplainFixture>>,
  taskId: string,
  binding = fixture.binding,
) {
  const receipt = await fixture.cell.run({ kind: "task-create", taskId, title: `Explain ${taskId}` }, binding);
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  await waitForFixturePublication(fixture.cell, receipt.opId, binding);
  return receipt;
}

test("explain reports allowed and denied rows for the authenticated actor at one canonical cut", async () => {
  const fixture = await openExplainFixture(),
    { rootDir, repoId, realm, binding, cell } = fixture;
  try {
    realm.keycloak.permit(actor.principal.personId, repoId, ["task-create"]);
    await createTask(fixture, "task-explain-allowed");
    const result = await cell.read(method, explainPayload(["task/task-explain-allowed"]), binding),
      subject = result.subjects[0]!,
      allowed = subject.actions.find(({ action }) => action.id === "create"),
      denied = subject.actions.find(({ action }) => action.id === "transition");
    assert.equal(result.mode, "object");
    assert.equal(subject.ref, "task/task-explain-allowed");
    assert.match(String(result.evaluatedAtCut), /^canonical:\d+$/u);
    // The Web caller never supplies the actor: every decision names the transport principal.
    assert.deepEqual(allowed?.authorizationDecision?.actor, actor);
    assert.equal(allowed?.authorizationDecision?.outcome, "allowed");
    assert.deepEqual(allowed?.authorizationDecision?.reasonCodes, ["keycloak_allowed"]);
    assert.equal(allowed?.authorizationDecision?.evaluatedAtCut, result.evaluatedAtCut);
    assert.equal(denied?.authorizationDecision?.outcome, "denied");
    assert.deepEqual(denied?.authorizationDecision?.reasonCodes, ["keycloak_denied"]);
    assert.equal(denied?.available, false);
    assert.ok((denied?.authorizationDecision?.nextActions.length ?? 0) > 0);
    assert.equal(
      subject.actions.every(({ evaluatedAtCut }) => evaluatedAtCut === result.evaluatedAtCut),
      true,
    );
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("revoking a grant after explain denies the next explain and the real write", async () => {
  const fixture = await openExplainFixture(),
    { rootDir, repoId, realm, binding, cell } = fixture;
  try {
    realm.keycloak.permit(actor.principal.personId, repoId, ["task-create"]);
    await createTask(fixture, "task-explain-before-revoke");
    const before = await cell.read(method, explainPayload(["task/task-explain-before-revoke"]), binding),
      beforeCreate = before.subjects[0]!.actions.find(({ action }) => action.id === "create");
    assert.equal(beforeCreate?.authorizationDecision?.outcome, "allowed");

    realm.keycloak.revoke(actor.principal.personId, repoId, ["task-create"]);
    const after = await cell.read(method, explainPayload(["task/task-explain-before-revoke"]), binding),
      afterCreate = after.subjects[0]!.actions.find(({ action }) => action.id === "create");
    // The cut did not move; the authority did. Freshness is per-request evaluation, not a cut cache.
    assert.equal(after.evaluatedAtCut, before.evaluatedAtCut);
    assert.equal(afterCreate?.authorizationDecision?.outcome, "denied");
    assert.deepEqual(afterCreate?.authorizationDecision?.reasonCodes, ["keycloak_denied"]);

    const rejected = await cell.run(
      { kind: "task-create", taskId: "task-explain-after-revoke", title: "Write after revoke" },
      binding,
    );
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "authorization_denied");
    assert.equal(rejected.authorizationDecision?.outcome, "denied");
    assert.deepEqual(rejected.authorizationDecision?.reasonCodes, ["keycloak_denied"]);
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repeated explain refs preserve output positions without repeating online authority reads", async (t) => {
  const fixture = await openExplainFixture(),
    { rootDir, repoId, realm, binding, cell } = fixture,
    samples: { positions: number; requests: number; durationMs: number }[] = [];
  try {
    realm.keycloak.permit(actor.principal.personId, repoId, ["task-create"]);
    await createTask(fixture, "task-repeat-a");
    await createTask(fixture, "task-repeat-b");
    const refs = ["task/task-repeat-a", "task/task-repeat-b"];
    for (const positions of [2, 20, 100, 500]) {
      let requests = 0;
      const input = Array.from({ length: positions }, (_, index) => refs[index % refs.length]!),
        started = performance.now(),
        result = await withFetch(
          (...args) => {
            requests += 1;
            return fetchOriginal(...args);
          },
          () => cell.read(method, explainPayload(input), binding),
        );
      samples.push({ positions, requests, durationMs: performance.now() - started });
      t.diagnostic(JSON.stringify(samples.at(-1)));
      assert.deepEqual(
        result.subjects.map(({ ref }) => ref),
        input,
      );
      assert.equal(result.mode, "object");
      assert.ok(
        result.subjects.every(({ actions }) =>
          actions.every(({ evaluatedAtCut }) => evaluatedAtCut === result.evaluatedAtCut),
        ),
      );
    }
    // Warm the provider once, then assert operation counts rather than a machine speed budget.
    assert.equal(samples[2]!.requests, samples[1]!.requests);
    assert.equal(samples[3]!.requests, samples[1]!.requests);
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

const fetchOriginal = globalThis.fetch;

test("authority transport outage is unavailable while a malformed authority response is not", async () => {
  const fixture = await openExplainFixture(),
    { rootDir, repoId, realm, binding, cell } = fixture;
  try {
    realm.keycloak.permit(actor.principal.personId, repoId, ["task-create"]);
    await createTask(fixture, "task-explain-outage");
    // explain resolves the online authority through the host fetch port, exactly as production does.
    await assert.rejects(
      withFetch(
        async () => {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
          });
        },
        () => cell.read(method, explainPayload(["task/task-explain-outage"]), binding),
      ),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "keycloak_unavailable");
        assert.match(error.message, /Keycloak identity authority/u);
        return true;
      },
    );

    // A provider that answers garbage is a defect, not an identity outage: clients must not retry
    // it as `keycloak_unavailable`, and monitoring must distinguish it from a transport failure.
    await assert.rejects(
      withFetch(
        async () => new Response("not-json", { status: 200 }),
        () => cell.read(method, explainPayload(["task/task-explain-outage"]), binding),
      ),
      (error: Error & { readonly code?: string }) => {
        assert.notEqual(error.code, "keycloak_unavailable");
        assert.match(error.message, /JSON/u);
        return true;
      },
    );
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("HTTP 5xx from the session or center authority is unavailable, not a denial", async () => {
  const fixture = await openExplainFixture(),
    { rootDir, repoId, realm, binding, cell } = fixture;
  try {
    realm.keycloak.permit(actor.principal.personId, repoId, ["task-create"]);
    await createTask(fixture, "task-explain-http-503");
    // Session/UMA path: a 503 is not a "no grant" answer and must not become keycloak_denied.
    await assert.rejects(
      withFetch(
        async () => new Response("unavailable", { status: 503 }),
        () => cell.read(method, explainPayload(["task/task-explain-http-503"]), binding),
      ),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "keycloak_unavailable");
        return true;
      },
    );

    const centerProvider = new KeycloakPolicyAdapter(
        { url: realm.url, realm: "harness", resourceServerClientId: "harness-center" },
        realm.fetch,
      ),
      centerBinding: RepoCellBinding = {
        ...binding,
        keycloakAuthorization: {
          ...binding.keycloakAuthorization!,
          center: async () => ({
            provider: centerProvider,
            url: realm.url,
            realm: "harness",
            clientId: "harness-center",
            accessToken: "center-token",
          }),
        },
      };
    // Center path: userinfo succeeds, then Admin REST answers 503. The 503 is an availability
    // answer even though it arrives from a reachable endpoint.
    await assert.rejects(
      withFetch(
        async (input) =>
          String(input).includes("/protocol/openid-connect/userinfo")
            ? Response.json({ sub: actor.principal.personId, harness_person_id: actor.principal.personId })
            : new Response("unavailable", { status: 503 }),
        () => cell.read(method, explainPayload(["task/task-explain-http-503"]), centerBinding),
      ),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "keycloak_unavailable");
        return true;
      },
    );
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("person explain reports person-directory 503 and connection failure as unavailable", async () => {
  const fixture = await openExplainFixture(),
    { rootDir, realm, binding, cell } = fixture;
  try {
    const centerProvider = (fetchPort: typeof fetch) =>
        new KeycloakPolicyAdapter(
          { url: realm.url, realm: "harness", resourceServerClientId: "harness-center" },
          fetchPort,
        ),
      centerBinding = (fetchPort: typeof fetch): RepoCellBinding => ({
        ...binding,
        keycloakAuthorization: {
          ...binding.keycloakAuthorization!,
          center: async () => ({
            provider: centerProvider(fetchPort),
            url: realm.url,
            realm: "harness",
            clientId: "harness-center",
            accessToken: "center-token",
          }),
        },
      }),
      personRef = "person/person-explain-target",
      readPerson = (fetchPort: typeof fetch) =>
        cell.read(method, explainPayload([personRef]), centerBinding(fetchPort));

    // The Person existence lookup runs before the action evaluation loop; its 503 and connection
    // failure must use the same availability classification as the loop itself.
    await assert.rejects(
      readPerson(async () => new Response(null, { status: 503 })),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "keycloak_unavailable");
        return true;
      },
    );
    await assert.rejects(
      readPerson(async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      }),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "keycloak_unavailable");
        return true;
      },
    );
    // A malformed directory response is still a defect, not an outage.
    await assert.rejects(
      readPerson(async () => new Response("not-json", { status: 200 })),
      (error: Error & { readonly code?: string }) => {
        assert.notEqual(error.code, "keycloak_unavailable");
        return true;
      },
    );
    // Acquiring the center credential is also an authority boundary.
    await assert.rejects(
      cell.read(method, explainPayload([personRef]), {
        ...binding,
        keycloakAuthorization: {
          ...binding.keycloakAuthorization!,
          center: async () => {
            throw Object.assign(new Error("center token unavailable"), { code: "daemon_error" });
          },
        },
      }),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "keycloak_unavailable");
        return true;
      },
    );
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("catalog discovers every action without authorizing, and identity preconditions fail closed", async () => {
  const fixture = await openExplainFixture(),
    { rootDir, repoId, realm, binding, cell } = fixture;
  try {
    realm.keycloak.permit(actor.principal.personId, repoId, ["task-create"]);
    await createTask(fixture, "task-explain-catalog");
    const object = await cell.read(method, explainPayload(["task/task-explain-catalog"]), binding),
      catalog = await cell.read(method, catalogPayload("task"), binding),
      objectIds = object.subjects[0]!.actions.map(({ action }) => action.id),
      catalogIds = catalog.subjects[0]!.actions.map(({ action }) => action.id);
    assert.equal(catalog.mode, "catalog");
    assert.equal(catalog.evaluatedAtCut, null);
    assert.deepEqual(catalogIds, objectIds);
    assert.equal(
      catalog.subjects[0]!.actions.every(
        ({ available, authorizationDecision, evaluatedAtCut, unmetCriteria }) =>
          available === null && authorizationDecision === null && evaluatedAtCut === null && unmetCriteria.length === 0,
      ),
      true,
    );
    assert.equal(
      catalog.subjects[0]!.actions.every(({ criteria }) =>
        criteria.every(({ status, nextActions }) => status === "not-evaluated" && nextActions.length === 0),
      ),
      true,
    );

    const unsupported = await cell.read(method, explainPayload(["fact/F-ABCDEFGH"]), binding);
    assert.equal(unsupported.mode, "failure");
    assert.equal(unsupported.subjects[0]!.failure?.code, "unsupported_explain_target");

    await assert.rejects(
      cell.read(method, catalogPayload("not-a-kind"), binding),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "invalid_command");
        return true;
      },
    );
    await assert.rejects(
      cell.read(method, explainPayload(["task/task-explain-catalog"])),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "authentication_required");
        return true;
      },
    );
    await assert.rejects(
      cell.read(
        method,
        { ...explainPayload(["task/task-explain-catalog"]), executor: { kind: "agent", id: "agent-web-claimed" } },
        binding,
      ),
      (error: Error & { readonly code?: string }) => {
        assert.equal(error.code, "executor_binding_invalid");
        return true;
      },
    );
  } finally {
    await cell.close();
    await realm.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** Run one read while the host fetch port is the only authority transport, as production wires it. */
async function withFetch<T>(fetchPort: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchPort;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
