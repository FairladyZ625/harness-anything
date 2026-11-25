// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinPolicyAdapter } from "@harness-anything/authorization/builtin";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization/keycloak";
import type { AuthorizationResource, TaskIndexProjectionRow, TaskProjectionListQuery } from "@harness-anything/kernel";
import { authorizeTaskScopedRepositoryRead } from "../src/daemon-host/host-action-authorization.ts";
import {
  canonicalResourceAncestors,
  collectTaskAuthorizationAncestry,
  resolveTaskResourceAncestorsBatch,
  type TaskAuthorizationAncestryCutCache,
} from "../src/daemon-host/repo-cell-authorization.ts";
import type { RepoCellBinding, TaskAuthorizationMetadata } from "../src/daemon-host/repo-cell-types.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const kcConfig = {
  url: "http://127.0.0.1:8080",
  realm: "harness",
  resourceServerClientId: "harness-center",
};

function makeIndexProjection(
  rows: readonly TaskAuthorizationMetadata[],
  cutState: { sourceRevision: number; watermark: number; status: "ready" | "pending" } = {
    sourceRevision: 100,
    watermark: 100,
    status: "ready",
  },
) {
  let indexQueries = 0;
  let fullScans = 0;
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  const toIndexRow = (row: TaskAuthorizationMetadata): TaskIndexProjectionRow => ({
    taskId: row.taskId,
    supersededBy: null,
    title: row.taskId,
    status: "planned",
    pinned: false,
    parentTaskId: row.parentTaskId,
    workKind: null,
    riskTier: null,
    urgency: null,
    taskClass: row.taskClass,
    packageDisposition: "active",
    packagePath: `tasks/${row.taskId}`,
    updatedAt: "2026-11-25T00:00:00.000Z",
  });
  return {
    get indexQueries() {
      return indexQueries;
    },
    get fullScans() {
      return fullScans;
    },
    readCut: () => ({ ...cutState }),
    readTaskIndex: (query: TaskProjectionListQuery = {}) => {
      indexQueries += 1;
      if (query.taskIds === undefined) {
        fullScans += 1;
        return { rows: rows.map(toIndexRow), page: null };
      }
      const matched = query.taskIds
        .map((id) => byId.get(id))
        .filter((row): row is TaskAuthorizationMetadata => row !== undefined)
        .map(toIndexRow);
      return { rows: matched, page: null };
    },
  };
}

function makeChain(
  length: number,
  prefix: string,
  rootClass: "standard" | "work" = "standard",
): TaskAuthorizationMetadata[] {
  return Array.from({ length }, (_, index) => ({
    taskId: `${prefix}_${String(index).padStart(4, "0")}`,
    parentTaskId: index === 0 ? null : `${prefix}_${String(index - 1).padStart(4, "0")}`,
    taskClass: index === 0 ? rootClass : "standard",
  }));
}

function pinFetchPort(adapter: KeycloakPolicyAdapter): KeycloakPolicyAdapter {
  // Prevent evaluateOnlinePersonTargets from rebinding the fake in-memory adapter to globalThis.fetch.
  return Object.defineProperty(adapter, "withFetchPort", { value: undefined, configurable: true });
}

test("50-task batch on a 1,377-deep parentTaskId chain uses 1 IPC call and O(1) Keycloak requests, with immediate revocation", async () => {
  const depth = 1_377;
  const chain = makeChain(depth, "task_soak", "standard");
  const cutState = { sourceRevision: 26_650, watermark: 26_650, status: "ready" as const };
  const projection = makeIndexProjection(chain, cutState);
  let cutCache: TaskAuthorizationAncestryCutCache | undefined;
  let ancestryIpcCalls = 0;
  let metadataIpcCalls = 0;

  const cell = {
    readTaskAuthorizationMetadata: async (taskIds: readonly string[]) => {
      metadataIpcCalls += 1;
      return projection.readTaskIndex({ taskIds }).rows.map(({ taskId, parentTaskId, taskClass }) => ({
        taskId,
        parentTaskId,
        taskClass,
      }));
    },
    readTaskAuthorizationAncestry: async (taskIds: readonly string[]) => {
      ancestryIpcCalls += 1;
      const collected = collectTaskAuthorizationAncestry(projection, taskIds, cutCache);
      cutCache = collected.cache;
      return collected.rows;
    },
  };

  const realm = fakeKeycloak();
  const userToken = realm.account("person-soak");
  realm.permit("person-soak", "nightly-soak", ["repository-read"]);

  let userinfoCalls = 0;
  let evaluateCalls = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/protocol/openid-connect/userinfo")) userinfoCalls += 1;
    if (url.includes("/policy/evaluate")) evaluateCalls += 1;
    return realm.fetch(input, init);
  };
  const provider = pinFetchPort(new KeycloakPolicyAdapter(kcConfig, countingFetch));
  const binding: RepoCellBinding = {
    actor: { principal: { personId: "person-soak" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        provider,
        personId: "person-soak",
        accessToken: userToken,
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      },
      center: async () => ({
        provider,
        accessToken: "center-token",
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      }),
    },
  };

  const batch50 = chain.slice(depth - 50).map((row) => row.taskId);
  const first = await authorizeTaskScopedRepositoryRead({
    kind: "repository-read",
    repoId: "nightly-soak",
    cell,
    binding,
    target: { taskIds: batch50 },
  });
  assert.equal(first.outcome, "allowed");
  assert.equal(ancestryIpcCalls, 1, "must resolve full 1,377-deep ancestry in 1 batched IPC call");
  assert.equal(metadataIpcCalls, 0, "must not issue per-task metadata IPC calls");
  assert.equal(projection.fullScans, 1, "cold deep chain (>8 hops) loads index once");
  assert.equal(userinfoCalls, 1, "must validate user token once per batch (not 50x)");
  assert.equal(evaluateCalls, 1, "must evaluate covering repository grant once per batch (not 50x)");

  // Warm cut: second 50-task batch at the same sourceRevision hits cut cache (0 additional SQL queries).
  const queriesAfterFirst = projection.indexQueries;
  const batch50Mid = chain.slice(600, 650).map((row) => row.taskId);
  const second = await authorizeTaskScopedRepositoryRead({
    kind: "repository-read",
    repoId: "nightly-soak",
    cell,
    binding,
    target: { taskIds: batch50Mid },
  });
  assert.equal(second.outcome, "allowed");
  assert.equal(ancestryIpcCalls, 2);
  assert.equal(projection.indexQueries, queriesAfterFirst, "warm ready cut reuses cached ancestry index");
  assert.equal(userinfoCalls, 2, "each request still validates user token fresh (no cross-request auth cache)");
  assert.equal(evaluateCalls, 2, "each request still evaluates Keycloak fresh (no cross-request policy cache)");

  // Cut invalidation: advancing sourceRevision refreshes the projection cache.
  cutState.sourceRevision += 1;
  cutState.watermark += 1;
  await authorizeTaskScopedRepositoryRead({
    kind: "repository-read",
    repoId: "nightly-soak",
    cell,
    binding,
    target: { taskIds: batch50.slice(0, 5) },
  });
  assert.ok(projection.indexQueries > queriesAfterFirst, "advancing cut must invalidate ancestry cut cache");

  // Immediate revocation: revoking grant takes effect on the very next batch call.
  realm.revoke("person-soak", "nightly-soak", ["repository-read"]);
  await assert.rejects(
    authorizeTaskScopedRepositoryRead({
      kind: "repository-read",
      repoId: "nightly-soak",
      cell,
      binding,
      target: { taskIds: batch50 },
    }),
    (error: unknown) => (error as { code?: string }).code === "authorization_denied",
  );
});

test("mixed Work ancestors allow shared authorized Work in O(1) evaluations and fail closed on unauthorized sibling Work regardless of ordering", async () => {
  const workAChain = makeChain(300, "task_worka", "work");
  const workBChain = makeChain(300, "task_workb", "work");
  const projection = makeIndexProjection([...workAChain, ...workBChain]);
  let ancestryIpcCalls = 0;
  const cell = {
    readTaskAuthorizationAncestry: async (taskIds: readonly string[]) => {
      ancestryIpcCalls += 1;
      return collectTaskAuthorizationAncestry(projection, taskIds).rows;
    },
  };

  const realm = fakeKeycloak();
  const userToken = realm.account("person-work-a");
  // Grant ONLY on task_worka_0000 (no repository-wide grant, no workB grant).
  realm.permit("person-work-a", "repo-mixed:task/task_worka_0000", ["repository-read"]);

  let evaluateCalls = 0;
  const provider = pinFetchPort(
    new KeycloakPolicyAdapter(kcConfig, async (input, init) => {
      if (String(input).includes("/policy/evaluate")) evaluateCalls += 1;
      return realm.fetch(input, init);
    }),
  );
  const binding: RepoCellBinding = {
    actor: { principal: { personId: "person-work-a" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        provider,
        personId: "person-work-a",
        accessToken: userToken,
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      },
      center: async () => ({
        provider,
        accessToken: "center-token",
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      }),
    },
  };

  const authorizedBatch = workAChain.slice(250, 300).map((row) => row.taskId);
  const allowed = await authorizeTaskScopedRepositoryRead({
    kind: "repository-read",
    repoId: "repo-mixed",
    cell,
    binding,
    target: { taskIds: authorizedBatch },
  });
  assert.equal(allowed.outcome, "allowed");
  assert.equal(ancestryIpcCalls, 1);
  // Only workA_0000 exists as a Keycloak resource -> 1 policy/evaluate call for all 50 tasks!
  assert.equal(evaluateCalls, 1, "shared Work ancestor must be evaluated once across all 50 tasks");

  const mixedForward = [
    ...workAChain.slice(275, 300).map((row) => row.taskId),
    ...workBChain.slice(275, 300).map((row) => row.taskId),
  ];
  const mixedReverse = [
    ...workBChain.slice(275, 300).map((row) => row.taskId),
    ...workAChain.slice(275, 300).map((row) => row.taskId),
  ];
  for (const taskIds of [mixedForward, mixedReverse]) {
    evaluateCalls = 0;
    await assert.rejects(
      authorizeTaskScopedRepositoryRead({
        kind: "repository-read",
        repoId: "repo-mixed",
        cell,
        binding,
        target: { taskIds },
      }),
      (error: unknown) => (error as { code?: string }).code === "authorization_denied",
      "mixed-Work batch must fail closed regardless of order",
    );
    assert.ok(evaluateCalls <= 2, `stopOnDeny must keep evaluations bounded; observed ${evaluateCalls}`);
  }
});

test("preserves explicit per-task deny on custom providers without authorizePersonBatch while keeping 1-IPC ancestry and 1 token check", async () => {
  const chain = makeChain(500, "task_custom", "work");
  const projection = makeIndexProjection(chain);
  let ancestryIpcCalls = 0;
  const cell = {
    readTaskAuthorizationAncestry: async (taskIds: readonly string[]) => {
      ancestryIpcCalls += 1;
      return collectTaskAuthorizationAncestry(projection, taskIds).rows;
    },
  };

  let validateCalls = 0;
  const evaluatedRefs: string[] = [];
  const deniedTaskId = "task_custom_0475";
  const customProvider: NonNullable<NonNullable<RepoCellBinding["keycloakAuthorization"]>["session"]>["provider"] = {
    policyRef: "custom-deny-policy@1",
    authority: "custom",
    deniedReasonCode: "custom_denied",
    validateUserAccessToken: async () => {
      validateCalls += 1;
      return true;
    },
    authorize: async () => {
      throw new Error("center path expected");
    },
    authorizePerson: async ({ resource, resourceAncestors }) => {
      const ref = resource.kind === "entity" ? resource.entityRef : resource.kind;
      evaluatedRefs.push(ref);
      // Verify the Work root ancestor was accurately resolved even at depth 500.
      assert.deepEqual(resourceAncestors, [
        { kind: "entity", repoId: "repo-custom", entityRef: "task/task_custom_0000" },
      ]);
      if (resource.kind === "entity" && resource.entityRef === `task/${deniedTaskId}`) {
        return { outcome: "denied", reasonCode: "explicit_task_deny", resource: ref, scope: "repository-read" };
      }
      return { outcome: "allowed", reasonCode: "custom_allowed", resource: ref, scope: "repository-read" };
    },
  };

  const binding: RepoCellBinding = {
    actor: { principal: { personId: "person-custom" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        provider: customProvider,
        personId: "person-custom",
        accessToken: "custom-token",
        url: "custom:",
        realm: "custom",
        clientId: "custom",
      },
      center: async () => ({
        provider: customProvider as never,
        accessToken: "custom-center-token",
        url: "custom:",
        realm: "custom",
        clientId: "custom",
      }),
    },
  };

  const batch50 = chain.slice(450, 500).map((row) => row.taskId);
  await assert.rejects(
    authorizeTaskScopedRepositoryRead({
      kind: "repository-read",
      repoId: "repo-custom",
      cell,
      binding,
      target: { taskIds: batch50 },
    }),
    (error: unknown) => {
      const err = error as {
        code?: string;
        authorizationDecision?: { reasonCodes?: readonly string[]; subject?: string };
      };
      return (
        err.code === "authorization_denied" &&
        err.authorizationDecision?.reasonCodes?.includes("explicit_task_deny") === true &&
        err.authorizationDecision?.subject === `task/${deniedTaskId}`
      );
    },
  );
  assert.equal(ancestryIpcCalls, 1, "custom provider still benefits from 1-IPC batched ancestry");
  assert.equal(validateCalls, 1, "custom provider still validates user token once per batch");
  // Stopped immediately at index 25 (custom_0475): 26 calls instead of all 50.
  assert.equal(evaluatedRefs.length, 26);
  assert.equal(evaluatedRefs.at(-1), `task/${deniedTaskId}`);
});

test("metadata-only cell fallback batches frontier lookups instead of O(N*depth) calls", async () => {
  const work = { taskId: "task_wroot", parentTaskId: null, taskClass: "work" as const };
  const mid = { taskId: "task_mid_1", parentTaskId: "task_wroot", taskClass: "standard" as const };
  const leaves = Array.from({ length: 50 }, (_, index) => ({
    taskId: `task_leaf_${index}`,
    parentTaskId: "task_mid_1",
    taskClass: "standard" as const,
  }));
  const byId = new Map([work, mid, ...leaves].map((row) => [row.taskId, row]));
  let metadataCalls = 0;
  const cell = {
    readTaskAuthorizationMetadata: async (taskIds: readonly string[]) => {
      metadataCalls += 1;
      return taskIds.map((id) => byId.get(id)).filter((row): row is TaskAuthorizationMetadata => row !== undefined);
    },
  };

  const realm = fakeKeycloak();
  const userToken = realm.account("person-leaf");
  realm.permit("person-leaf", "repo-fb:task/task_wroot", ["repository-read"]);
  const provider = pinFetchPort(new KeycloakPolicyAdapter(kcConfig, realm.fetch));
  const binding: RepoCellBinding = {
    actor: { principal: { personId: "person-leaf" }, executor: null },
    source: "local",
    keycloakAuthorization: {
      session: {
        provider,
        personId: "person-leaf",
        accessToken: userToken,
        url: kcConfig.url,
        realm: kcConfig.realm,
        clientId: kcConfig.resourceServerClientId,
      },
    },
  };

  const decision = await authorizeTaskScopedRepositoryRead({
    kind: "repository-read",
    repoId: "repo-fb",
    cell,
    binding,
    target: { taskIds: leaves.map((row) => row.taskId) },
  });
  assert.equal(decision.outcome, "allowed");
  // 3 frontier levels: [50 leaves] -> [mid-1] -> [w-root] = 3 calls (not 50*3 = 150 calls!).
  assert.equal(metadataCalls, 3);
});

test("resolveTaskResourceAncestorsBatch matches canonicalResourceAncestors across nested Works, root-before-child ordering, missing parents, and cycles", async () => {
  const tasks: Record<
    string,
    { readonly taskClass: "standard" | "work"; readonly metadata: { readonly parentTaskId: string | null } }
  > = {
    wOuter: { taskClass: "work", metadata: { parentTaskId: null } },
    wInner: { taskClass: "work", metadata: { parentTaskId: "wOuter" } },
    tNested: { taskClass: "standard", metadata: { parentTaskId: "wInner" } },
    derivedRoot: { taskClass: "standard", metadata: { parentTaskId: null } },
    derivedChild: { taskClass: "standard", metadata: { parentTaskId: "derivedRoot" } },
    dangling: { taskClass: "standard", metadata: { parentTaskId: "does-not-exist" } },
    cycWork: { taskClass: "work", metadata: { parentTaskId: "cycChild" } },
    cycChild: { taskClass: "standard", metadata: { parentTaskId: "cycWork" } },
    cycTail: { taskClass: "standard", metadata: { parentTaskId: "cycChild" } },
  };
  const read = (id: string) => tasks[id] ?? null;
  const resources: readonly AuthorizationResource[] = [
    // Deliberately put roots BEFORE their children to test memoization edge cases.
    { kind: "entity", repoId: "r", entityRef: "task/wOuter" },
    { kind: "entity", repoId: "r", entityRef: "task/wInner" },
    { kind: "entity", repoId: "r", entityRef: "task/tNested" },
    { kind: "entity", repoId: "r", entityRef: "task/derivedRoot" },
    { kind: "entity", repoId: "r", entityRef: "task/derivedChild" },
    { kind: "entity", repoId: "r", entityRef: "task/dangling" },
    { kind: "entity", repoId: "r", entityRef: "task/cycChild" },
    { kind: "entity", repoId: "r", entityRef: "task/cycTail" },
    { kind: "repository", repoId: "r" },
  ];

  const batchResult = await resolveTaskResourceAncestorsBatch(read, resources);
  for (let index = 0; index < resources.length; index += 1) {
    const single = await canonicalResourceAncestors(read, resources[index]!);
    assert.deepEqual(batchResult[index], single, `mismatch for resource ${JSON.stringify(resources[index])}`);
  }
});

test("BuiltinPolicyAdapter authorizeBatch and authorizePersonBatch match single-target decisions and honor stopOnDeny", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-batch-"));
  t.after(() => removeTempRepository(root));
  const adapter = new BuiltinPolicyAdapter({ userRoot: root });
  adapter.addUser({
    username: "owner",
    personId: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "synthetic-owner-password",
  });
  const centerToken = adapter.issueCenterToken();
  const userToken = "synthetic-owner-session";
  adapter.registerSession(userToken, {
    personId: "owner",
    subject: "owner",
    expiresAt: Date.now() + 60_000,
    sessionExpiresAt: null,
    roles: [],
  });
  await adapter.claimRepositoryOwner(centerToken, "repo-a", "owner");

  const targets = [
    { resource: { kind: "entity" as const, repoId: "repo-a", entityRef: "task/t1" }, resourceAncestors: [] },
    { resource: { kind: "entity" as const, repoId: "repo-b", entityRef: "task/t2" }, resourceAncestors: [] },
    { resource: { kind: "entity" as const, repoId: "repo-a", entityRef: "task/t3" }, resourceAncestors: [] },
  ];
  const userBatch = await adapter.authorizeBatch({
    userAccessToken: userToken,
    action: "repository-read",
    targets,
    shortCircuit: true,
  });
  assert.deepEqual(
    userBatch.map((d) => d.outcome),
    ["allowed", "denied"],
  );
  const personBatch = await adapter.authorizePersonBatch({
    adminAccessToken: centerToken,
    personId: "owner",
    action: "repository-read",
    targets,
    shortCircuit: false,
  });
  assert.deepEqual(
    personBatch.map((d) => d.outcome),
    ["allowed", "denied", "allowed"],
  );
});
